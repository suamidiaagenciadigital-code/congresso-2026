const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function autenticar(req) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    jwt.verify(token, process.env.JWT_SECRET);
    return true;
  } catch { return false; }
}

async function dispararEmail(campanha, destinatarios) {
  const resend = new Resend(process.env.RESEND_API_KEY_PRO);
  const from = process.env.RESEND_FROM_MARKETING || process.env.RESEND_FROM || 'XVII Congresso Fenapestalozzi <noreply@congressopestalozzi.org.br>';
  const BASE_URL = process.env.BASE_URL || 'https://congressopestalozzi.vercel.app';

  let enviados = 0, falhas = 0;
  const LOTE = 50;

  for (let i = 0; i < destinatarios.length; i += LOTE) {
    const lote = destinatarios.slice(i, i + LOTE);

    await Promise.all(lote.map(async (d) => {
      const linkDescadastro = `${BASE_URL}/api/descadastrar?email=${encodeURIComponent(d.email)}&camp=${campanha.id}`;

      const html = (campanha.conteudo_html || '')
        .replace('{{nome}}', d.nome || 'Prezado(a)')
        + `\n<p style="font-size:11px;color:#999;text-align:center;margin-top:24px">
            <a href="${linkDescadastro}" style="color:#999">Descadastrar-se desta lista</a>
           </p>`;

      try {
        const result = await resend.emails.send({
          from,
          to: d.email,
          subject: campanha.assunto,
          html,
        });

        await supabase.from('disparos').update({
          status: 'enviado',
          provider_id: result.data?.id || null,
          enviado_em: new Date().toISOString(),
        }).eq('campanha_id', campanha.id).eq('destinatario', d.email);

        enviados++;
      } catch (e) {
        await supabase.from('disparos').update({
          status: 'falhou',
          erro: e.message?.slice(0, 200),
        }).eq('campanha_id', campanha.id).eq('destinatario', d.email);
        falhas++;
      }
    }));

    // Pequena pausa entre lotes para não sobrecarregar a API
    if (i + LOTE < destinatarios.length) await new Promise(r => setTimeout(r, 300));
  }

  return { enviados, falhas };
}

async function dispararWhatsApp(campanha, destinatarios) {
  const token    = process.env.ZAPI_TOKEN;
  const instance = process.env.ZAPI_INSTANCE;
  const clientToken = process.env.ZAPI_CLIENT_TOKEN;

  let enviados = 0, falhas = 0;

  for (const d of destinatarios) {
    const telefone = d.telefone.replace(/\D/g, '');
    if (telefone.length < 10) {
      await supabase.from('disparos').update({ status: 'falhou', erro: 'Telefone inválido' })
        .eq('campanha_id', campanha.id).eq('destinatario', d.telefone);
      falhas++;
      continue;
    }

    const numero = telefone.startsWith('55') ? telefone : '55' + telefone;
    const mensagem = (campanha.conteudo_text || '').replace('{{nome}}', d.nome || 'Prezado(a)');

    try {
      const resp = await fetch(`https://api.z-api.io/instances/${instance}/token/${token}/send-text`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Token': clientToken,
        },
        body: JSON.stringify({ phone: numero, message: mensagem }),
      });
      const json = await resp.json();

      await supabase.from('disparos').update({
        status: json.zaapId ? 'enviado' : 'falhou',
        provider_id: json.zaapId || null,
        erro: json.zaapId ? null : JSON.stringify(json).slice(0, 200),
        enviado_em: new Date().toISOString(),
      }).eq('campanha_id', campanha.id).eq('destinatario', d.telefone);

      if (json.zaapId) enviados++; else falhas++;
    } catch (e) {
      await supabase.from('disparos').update({ status: 'falhou', erro: e.message?.slice(0, 200) })
        .eq('campanha_id', campanha.id).eq('destinatario', d.telefone);
      falhas++;
    }

    // Pausa obrigatória entre mensagens WhatsApp para evitar bloqueio
    await new Promise(r => setTimeout(r, 1500));
  }

  return { enviados, falhas };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });
  if (!autenticar(req)) return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ success: false, mensagem: 'ID da campanha obrigatório.' });

  /* ── Buscar campanha ── */
  const { data: campanha, error: campErr } = await supabase
    .from('campanhas').select('*').eq('id', id).single();

  if (campErr || !campanha)
    return res.status(404).json({ success: false, mensagem: 'Campanha não encontrada.' });

  if (campanha.status !== 'aprovado')
    return res.status(400).json({ success: false, mensagem: 'Apenas campanhas com status "aprovado" podem ser disparadas.' });

  /* ── Verificar credenciais ── */
  if (campanha.tipo === 'email' && !process.env.RESEND_API_KEY_PRO) {
    return res.status(503).json({
      success: false,
      mensagem: 'Credencial de e-mail não configurada. Adicione RESEND_API_KEY_PRO nas variáveis de ambiente do Vercel.',
    });
  }
  if (campanha.tipo === 'whatsapp' && (!process.env.ZAPI_TOKEN || !process.env.ZAPI_INSTANCE)) {
    return res.status(503).json({
      success: false,
      mensagem: 'Credenciais do Z-API não configuradas. Adicione ZAPI_TOKEN, ZAPI_INSTANCE e ZAPI_CLIENT_TOKEN nas variáveis de ambiente do Vercel.',
    });
  }

  /* ── Buscar destinatários ── */
  let destinatarios = [];

  if (campanha.publico === 'inscritos') {
    const campo = campanha.tipo === 'email' ? 'email' : 'telefone';
    const { data } = await supabase.from('inscritos')
      .select(`nome_completo, nome_social, ${campo}`)
      .not(campo, 'is', null);

    destinatarios = (data || []).map(r => ({
      nome: r.nome_social || r.nome_completo,
      [campanha.tipo === 'email' ? 'email' : 'telefone']: r[campo],
    }));
  } else {
    const campo = campanha.tipo === 'email' ? 'email' : 'telefone';
    const { data } = await supabase.from('contatos_externos')
      .select(`nome, ${campo}`)
      .eq('ativo', true)
      .not(campo, 'is', null);

    // Excluir descadastrados (só para e-mail)
    if (campanha.tipo === 'email') {
      const { data: desc } = await supabase.from('descadastros').select('email');
      const descSet = new Set((desc || []).map(d => d.email.toLowerCase()));
      destinatarios = (data || [])
        .filter(r => !descSet.has(r.email.toLowerCase()))
        .map(r => ({ nome: r.nome, email: r.email }));
    } else {
      destinatarios = (data || []).map(r => ({ nome: r.nome, telefone: r.telefone }));
    }
  }

  if (!destinatarios.length)
    return res.status(400).json({ success: false, mensagem: 'Nenhum destinatário encontrado para esta campanha.' });

  /* ── Criar registros de disparo pendentes ── */
  const registros = destinatarios.map(d => ({
    campanha_id: campanha.id,
    destinatario: campanha.tipo === 'email' ? d.email : d.telefone,
    nome: d.nome,
    status: 'pendente',
  }));

  await supabase.from('disparos').insert(registros);

  /* ── Marcar campanha como enviando ── */
  await supabase.from('campanhas').update({
    status: 'enviando',
    iniciado_em: new Date().toISOString(),
  }).eq('id', id);

  /* ── Disparar ── */
  let resultado;
  if (campanha.tipo === 'email') {
    resultado = await dispararEmail(campanha, destinatarios);
  } else {
    resultado = await dispararWhatsApp(campanha, destinatarios);
  }

  /* ── Marcar campanha como concluída ── */
  await supabase.from('campanhas').update({
    status: 'concluido',
    concluido_em: new Date().toISOString(),
  }).eq('id', id);

  return res.status(200).json({
    success: true,
    mensagem: `Disparo concluído: ${resultado.enviados} enviados, ${resultado.falhas} falhas.`,
    total: destinatarios.length,
    enviados: resultado.enviados,
    falhas: resultado.falhas,
  });
};
