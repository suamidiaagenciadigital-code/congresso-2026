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

/* ── Disparo de e-mail via Resend Pro ── */
async function dispararEmail(campanha, destinatarios) {
  const resend = new Resend(process.env.RESEND_API_KEY_PRO);
  const from = process.env.RESEND_FROM_MARKETING || process.env.RESEND_FROM
    || 'XVII Congresso Fenapestalozzi <noreply@congressopestalozzi.org.br>';
  const BASE_URL = process.env.BASE_URL || 'https://congressopestalozzi.vercel.app';

  let enviados = 0, falhas = 0;
  const LOTE = 50;

  for (let i = 0; i < destinatarios.length; i += LOTE) {
    const lote = destinatarios.slice(i, i + LOTE);
    await Promise.all(lote.map(async (d) => {
      const linkDesc = `${BASE_URL}/api/descadastrar?email=${encodeURIComponent(d.email)}&camp=${campanha.id}`;
      const html = (campanha.conteudo_html || '').replace('{{nome}}', d.nome || 'Prezado(a)')
        + `\n<p style="font-size:11px;color:#999;text-align:center;margin-top:24px">
            <a href="${linkDesc}" style="color:#999">Descadastrar-se desta lista</a></p>`;
      try {
        const result = await resend.emails.send({ from, to: d.email, subject: campanha.assunto, html });
        await supabase.from('disparos').update({
          status: 'enviado', provider_id: result.data?.id || null, enviado_em: new Date().toISOString(),
        }).eq('campanha_id', campanha.id).eq('destinatario', d.email);
        enviados++;
      } catch (e) {
        await supabase.from('disparos').update({ status: 'falhou', erro: e.message?.slice(0, 200) })
          .eq('campanha_id', campanha.id).eq('destinatario', d.email);
        falhas++;
      }
    }));
    if (i + LOTE < destinatarios.length) await new Promise(r => setTimeout(r, 300));
  }
  return { enviados, falhas };
}

/* ── Disparo de WhatsApp via Z-API (texto, imagem ou vídeo) ── */
async function dispararWhatsApp(campanha, destinatarios) {
  const { ZAPI_TOKEN: token, ZAPI_INSTANCE: instance, ZAPI_CLIENT_TOKEN: clientToken } = process.env;
  let enviados = 0, falhas = 0;

  for (const d of destinatarios) {
    const tel = d.telefone.replace(/\D/g, '');
    if (tel.length < 10) {
      await supabase.from('disparos').update({ status: 'falhou', erro: 'Telefone inválido' })
        .eq('campanha_id', campanha.id).eq('destinatario', d.telefone);
      falhas++; continue;
    }
    const numero = tel.startsWith('55') ? tel : '55' + tel;
    const caption = (campanha.conteudo_text || '').replace('{{nome}}', d.nome || 'Prezado(a)');

    let endpoint, payload;
    if (campanha.midia_url && campanha.midia_tipo === 'imagem') {
      endpoint = 'send-image';
      payload  = { phone: numero, image: campanha.midia_url, caption };
    } else if (campanha.midia_url && campanha.midia_tipo === 'video') {
      endpoint = 'send-video';
      payload  = { phone: numero, video: campanha.midia_url, caption };
    } else {
      endpoint = 'send-text';
      payload  = { phone: numero, message: caption };
    }

    try {
      const resp = await fetch(`https://api.z-api.io/instances/${instance}/token/${token}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Client-Token': clientToken },
        body: JSON.stringify(payload),
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
    await new Promise(r => setTimeout(r, 1500));
  }
  return { enviados, falhas };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (!autenticar(req)) return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  /* ── GET: listar campanhas ── */
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('campanhas')
      .select('id, nome, tipo, publico, assunto, status, midia_url, midia_tipo, agendado_para, aprovado_por, aprovado_em, iniciado_em, concluido_em, criado_em')
      .order('criado_em', { ascending: false });
    if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao consultar campanhas.' });
    const stats = {};
    data.forEach(c => { stats[c.status] = (stats[c.status] || 0) + 1; });
    return res.status(200).json({ success: true, total: data.length, stats, campanhas: data });
  }

  /* ── POST ── */
  if (req.method === 'POST') {
    const body = req.body || {};

    /* --- Upload de mídia (WhatsApp) --- */
    if (body.action === 'upload-midia') {
      const { dados, tipo } = body;
      if (!dados || !tipo) return res.status(400).json({ success: false, mensagem: 'Dados e tipo obrigatórios.' });

      const exts = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
      };
      const ext = exts[tipo];
      if (!ext) return res.status(400).json({ success: false, mensagem: 'Formato não suportado. Use JPG, PNG, GIF, WEBP, MP4, MOV ou WEBM.' });

      const midiaTipo = tipo.startsWith('image/') ? 'imagem' : 'video';
      const buffer   = Buffer.from(dados, 'base64');

      // Limite: 10 MB para imagem, 50 MB para vídeo
      const limite = midiaTipo === 'imagem' ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
      if (buffer.length > limite)
        return res.status(400).json({ success: false, mensagem: `Arquivo muito grande. Limite: ${midiaTipo === 'imagem' ? '10' : '50'} MB.` });

      const filename = `${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('camp-midia').upload(filename, buffer, {
        contentType: tipo, upsert: false,
      });
      if (upErr) return res.status(500).json({ success: false, mensagem: 'Erro ao salvar mídia: ' + upErr.message });

      const { data: { publicUrl } } = supabase.storage.from('camp-midia').getPublicUrl(filename);
      return res.status(200).json({ success: true, url: publicUrl, midia_tipo: midiaTipo });
    }

    /* --- Disparar campanha --- */
    if (body.action === 'disparar') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, mensagem: 'ID obrigatório.' });

      const { data: campanha, error: campErr } = await supabase
        .from('campanhas').select('*').eq('id', id).single();
      if (campErr || !campanha)
        return res.status(404).json({ success: false, mensagem: 'Campanha não encontrada.' });
      if (campanha.status !== 'aprovado')
        return res.status(400).json({ success: false, mensagem: 'Apenas campanhas aprovadas podem ser disparadas.' });

      if (campanha.tipo === 'email' && !process.env.RESEND_API_KEY_PRO)
        return res.status(503).json({ success: false, mensagem: 'Credencial de e-mail não configurada. Adicione RESEND_API_KEY_PRO no Vercel.' });
      if (campanha.tipo === 'whatsapp' && (!process.env.ZAPI_TOKEN || !process.env.ZAPI_INSTANCE))
        return res.status(503).json({ success: false, mensagem: 'Credenciais Z-API não configuradas. Adicione ZAPI_TOKEN, ZAPI_INSTANCE e ZAPI_CLIENT_TOKEN no Vercel.' });

      let destinatarios = [];
      if (campanha.publico === 'inscritos') {
        const campo = campanha.tipo === 'email' ? 'email' : 'telefone';
        const { data } = await supabase.from('inscritos')
          .select(`nome_completo, nome_social, ${campo}`).not(campo, 'is', null);
        destinatarios = (data || []).map(r => ({ nome: r.nome_social || r.nome_completo, [campo]: r[campo] }));
      } else {
        const campo = campanha.tipo === 'email' ? 'email' : 'telefone';
        const { data } = await supabase.from('contatos_externos')
          .select(`nome, ${campo}`).eq('ativo', true).not(campo, 'is', null);
        if (campanha.tipo === 'email') {
          const { data: desc } = await supabase.from('descadastros').select('email');
          const descSet = new Set((desc || []).map(d => d.email.toLowerCase()));
          destinatarios = (data || []).filter(r => !descSet.has(r.email.toLowerCase()))
            .map(r => ({ nome: r.nome, email: r.email }));
        } else {
          destinatarios = (data || []).map(r => ({ nome: r.nome, telefone: r.telefone }));
        }
      }

      if (!destinatarios.length)
        return res.status(400).json({ success: false, mensagem: 'Nenhum destinatário encontrado.' });

      await supabase.from('disparos').insert(destinatarios.map(d => ({
        campanha_id: campanha.id,
        destinatario: campanha.tipo === 'email' ? d.email : d.telefone,
        nome: d.nome, status: 'pendente',
      })));
      await supabase.from('campanhas').update({ status: 'enviando', iniciado_em: new Date().toISOString() }).eq('id', id);

      const resultado = campanha.tipo === 'email'
        ? await dispararEmail(campanha, destinatarios)
        : await dispararWhatsApp(campanha, destinatarios);

      await supabase.from('campanhas').update({ status: 'concluido', concluido_em: new Date().toISOString() }).eq('id', id);

      return res.status(200).json({
        success: true,
        mensagem: `Disparo concluído: ${resultado.enviados} enviados, ${resultado.falhas} falhas.`,
        total: destinatarios.length, enviados: resultado.enviados, falhas: resultado.falhas,
      });
    }

    /* --- Criar campanha --- */
    const { nome, tipo, publico, assunto, conteudo_html, conteudo_text, agendado_para, status, midia_url, midia_tipo } = body;
    if (!nome || !tipo || !publico)
      return res.status(400).json({ success: false, mensagem: 'Campos obrigatórios: nome, tipo, publico.' });
    if (!['email', 'whatsapp'].includes(tipo))
      return res.status(400).json({ success: false, mensagem: 'Tipo inválido.' });
    if (!['inscritos', 'externos'].includes(publico))
      return res.status(400).json({ success: false, mensagem: 'Público inválido.' });
    if (tipo === 'email' && !assunto)
      return res.status(400).json({ success: false, mensagem: 'Assunto obrigatório para campanhas de e-mail.' });

    const statusFinal = ['rascunho', 'aprovado'].includes(status) ? status : 'rascunho';
    const extra = statusFinal === 'aprovado' ? { aprovado_em: new Date().toISOString(), aprovado_por: 'admin' } : {};

    const { data, error } = await supabase.from('campanhas').insert({
      nome: nome.trim(), tipo, publico,
      assunto: assunto?.trim() || null,
      conteudo_html: conteudo_html || null,
      conteudo_text: conteudo_text || null,
      agendado_para: agendado_para || null,
      midia_url: midia_url || null,
      midia_tipo: midia_tipo || null,
      status: statusFinal, ...extra,
    }).select('id').single();

    if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao criar campanha.' });
    return res.status(201).json({ success: true, id: data.id, mensagem: 'Campanha criada.' });
  }

  /* ── PATCH: atualizar campanha ── */
  if (req.method === 'PATCH') {
    const { id, status, nome, assunto, conteudo_html, conteudo_text, agendado_para, publico, midia_url, midia_tipo } = req.body || {};
    if (!id) return res.status(400).json({ success: false, mensagem: 'ID obrigatório.' });

    const { data: atual, error: fetchErr } = await supabase
      .from('campanhas').select('status').eq('id', id).single();
    if (fetchErr || !atual) return res.status(404).json({ success: false, mensagem: 'Campanha não encontrada.' });

    const campos = {};
    if (status) {
      const validas = {
        rascunho: ['aprovado', 'cancelado'],
        aguardando_aprovacao: ['aprovado', 'rascunho', 'cancelado'],
        aprovado: ['cancelado'],
      };
      if (!(validas[atual.status] || []).includes(status))
        return res.status(400).json({ success: false, mensagem: `Transição inválida: ${atual.status} → ${status}` });
      campos.status = status;
      if (status === 'aprovado') { campos.aprovado_em = new Date().toISOString(); campos.aprovado_por = 'admin'; }
    }
    if (atual.status === 'rascunho') {
      if (nome)                        campos.nome          = nome.trim();
      if (assunto)                     campos.assunto       = assunto.trim();
      if (conteudo_html !== undefined) campos.conteudo_html = conteudo_html;
      if (conteudo_text !== undefined) campos.conteudo_text = conteudo_text;
      if (agendado_para !== undefined) campos.agendado_para = agendado_para || null;
      if (publico)                     campos.publico       = publico;
      if (midia_url  !== undefined)    campos.midia_url     = midia_url  || null;
      if (midia_tipo !== undefined)    campos.midia_tipo    = midia_tipo || null;
    }
    if (!Object.keys(campos).length)
      return res.status(400).json({ success: false, mensagem: 'Nenhum campo para atualizar.' });

    const { error: updErr } = await supabase.from('campanhas').update(campos).eq('id', id);
    if (updErr) return res.status(500).json({ success: false, mensagem: 'Erro ao atualizar campanha.' });
    return res.status(200).json({ success: true, mensagem: 'Campanha atualizada.' });
  }

  return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });
};
