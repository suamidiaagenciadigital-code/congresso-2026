const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getConfigs(...chaves) {
  const { data } = await supabase.from('configuracoes').select('chave, valor').in('chave', chaves);
  const map = {};
  (data || []).forEach(r => { if (r.valor) map[r.chave] = r.valor; });
  return map;
}

function autenticar(req) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    jwt.verify(token, process.env.JWT_SECRET);
    return true;
  } catch { return false; }
}

/* ── Disparo de e-mail via Resend ── */
async function dispararEmail(campanha, destinatarios) {
  const cfg = await getConfigs('resend_key', 'resend_from', 'resend_from_marketing');
  const apiKey = cfg.resend_key || process.env.RESEND_API_KEY_PRO || process.env.RESEND_API_KEY;
  const resend = new Resend(apiKey);
  const from = cfg.resend_from_marketing || cfg.resend_from
    || process.env.RESEND_FROM_MARKETING || process.env.RESEND_FROM
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
      // Pixel de abertura + rastreamento de cliques
      const trackBase = `${BASE_URL}/api/inscrito?acao=track&c=${campanha.id}&e=${encodeURIComponent(d.email)}`;
      let htmlFinal = html
        .replace(/href="(https?:\/\/[^"]+)"/g, (match, url) => {
          if (url.includes('acao=track') || url.includes('/api/descadastrar')) return match;
          return `href="${trackBase}&t=click&url=${encodeURIComponent(url)}"`;
        });
      htmlFinal += `<img src="${trackBase}&t=open" width="1" height="1" style="display:none;border:0" alt="">`;

      try {
        const result = await resend.emails.send({ from, to: d.email, subject: campanha.assunto, html: htmlFinal });
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

/* ── Disparo de WhatsApp via Meta Cloud API ── */
async function dispararWhatsApp(campanha, destinatarios) {
  const cfg = await getConfigs('whatsapp_token', 'whatsapp_phone_id');
  const token   = cfg.whatsapp_token   || process.env.WHATSAPP_TOKEN;
  const phoneId = cfg.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
  let enviados = 0, falhas = 0;

  for (const d of destinatarios) {
    const tel = d.telefone.replace(/\D/g, '');
    if (tel.length < 10) {
      await supabase.from('disparos').update({ status: 'falhou', erro: 'Telefone inválido' })
        .eq('campanha_id', campanha.id).eq('destinatario', d.telefone);
      falhas++; continue;
    }
    const numero = tel.startsWith('55') ? tel : '55' + tel;
    const texto  = (campanha.conteudo_text || '').replace('{{nome}}', d.nome || 'Prezado(a)');

    let body;
    if (campanha.template_name) {
      const components = texto ? [{ type: 'body', parameters: [{ type: 'text', text: texto }] }] : [];
      body = {
        messaging_product: 'whatsapp', to: numero, type: 'template',
        template: {
          name: campanha.template_name,
          language: { code: campanha.template_language || 'pt_BR' },
          ...(components.length ? { components } : {}),
        },
      };
    } else if (campanha.midia_url && campanha.midia_tipo === 'imagem') {
      body = { messaging_product: 'whatsapp', to: numero, type: 'image', image: { link: campanha.midia_url, caption: texto } };
    } else if (campanha.midia_url && campanha.midia_tipo === 'video') {
      body = { messaging_product: 'whatsapp', to: numero, type: 'video', video: { link: campanha.midia_url, caption: texto } };
    } else {
      body = { messaging_product: 'whatsapp', to: numero, type: 'text', text: { body: texto } };
    }

    try {
      const resp = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await resp.json();
      const ok = !json.error && json.messages?.[0]?.id;
      await supabase.from('disparos').update({
        status: ok ? 'enviado' : 'falhou',
        provider_id: json.messages?.[0]?.id || null,
        erro: ok ? null : JSON.stringify(json.error || json).slice(0, 200),
        enviado_em: new Date().toISOString(),
      }).eq('campanha_id', campanha.id).eq('destinatario', d.telefone);
      if (ok) enviados++; else falhas++;
    } catch (e) {
      await supabase.from('disparos').update({ status: 'falhou', erro: e.message?.slice(0, 200) })
        .eq('campanha_id', campanha.id).eq('destinatario', d.telefone);
      falhas++;
    }
    await new Promise(r => setTimeout(r, 1000));
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

      const cfgDisp = await getConfigs('resend_key', 'whatsapp_token', 'whatsapp_phone_id');
      if (campanha.tipo === 'email' && !(cfgDisp.resend_key || process.env.RESEND_API_KEY_PRO || process.env.RESEND_API_KEY))
        return res.status(503).json({ success: false, mensagem: 'Chave Resend não configurada. Adicione em Configurações ou no Vercel.' });
      if (campanha.tipo === 'whatsapp' && !(cfgDisp.whatsapp_token || process.env.WHATSAPP_TOKEN) || !(cfgDisp.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID))
        return res.status(503).json({ success: false, mensagem: 'Credenciais WhatsApp não configuradas. Adicione em Configurações ou no Vercel.' });

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

    /* --- Envio de teste (sem alterar status da campanha) --- */
    if (body.action === 'enviar-teste') {
      const { id, destino } = body;
      if (!id || !destino) return res.status(400).json({ success: false, mensagem: 'ID e destino obrigatórios.' });

      const { data: campanha, error: campErr } = await supabase
        .from('campanhas').select('*').eq('id', id).single();
      if (campErr || !campanha)
        return res.status(404).json({ success: false, mensagem: 'Campanha não encontrada.' });

      if (campanha.tipo === 'email') {
        const resendKey = process.env.RESEND_API_KEY_PRO || process.env.RESEND_API_KEY;
        if (!resendKey) return res.status(503).json({ success: false, mensagem: 'Chave Resend não configurada.' });
        const resend = new Resend(resendKey);
        const from = process.env.RESEND_FROM_MARKETING || process.env.RESEND_FROM
          || 'XVII Congresso Fenapestalozzi <noreply@congressopestalozzi.org.br>';
        const html = (campanha.conteudo_html || '<p>Sem conteúdo HTML.</p>').replace('{{nome}}', 'Teste')
          + '\n<p style="font-size:11px;color:#999;text-align:center;margin-top:24px">[E-mail de teste — não é um disparo real]</p>';
        try {
          await resend.emails.send({ from, to: destino, subject: '[TESTE] ' + (campanha.assunto || campanha.nome), html });
          return res.status(200).json({ success: true, mensagem: `E-mail de teste enviado para ${destino}.` });
        } catch (e) {
          return res.status(500).json({ success: false, mensagem: 'Erro ao enviar: ' + e.message });
        }
      }

      if (campanha.tipo === 'whatsapp') {
        const cfgWa = await getConfigs('whatsapp_token', 'whatsapp_phone_id');
        const token   = cfgWa.whatsapp_token   || process.env.WHATSAPP_TOKEN;
        const phoneId = cfgWa.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
        if (!token || !phoneId) return res.status(503).json({ success: false, mensagem: 'Credenciais WhatsApp não configuradas. Acesse Configurações.' });
        const tel = destino.replace(/\D/g, '');
        const numero = tel.startsWith('55') ? tel : '55' + tel;
        const texto = (campanha.conteudo_text || '').replace('{{nome}}', 'Teste');
        let body;
        if (campanha.template_name) {
          const components = texto ? [{ type: 'body', parameters: [{ type: 'text', text: texto }] }] : [];
          body = {
            messaging_product: 'whatsapp', to: numero, type: 'template',
            template: {
              name: campanha.template_name,
              language: { code: campanha.template_language || 'pt_BR' },
              ...(components.length ? { components } : {}),
            },
          };
        } else if (campanha.midia_url && campanha.midia_tipo === 'imagem') {
          body = { messaging_product: 'whatsapp', to: numero, type: 'image', image: { link: campanha.midia_url, caption: texto } };
        } else if (campanha.midia_url && campanha.midia_tipo === 'video') {
          body = { messaging_product: 'whatsapp', to: numero, type: 'video', video: { link: campanha.midia_url, caption: texto } };
        } else {
          body = { messaging_product: 'whatsapp', to: numero, type: 'text', text: { body: texto } };
        }
        try {
          const resp = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const json = await resp.json();
          const ok = !json.error && json.messages?.[0]?.id;
          if (ok) return res.status(200).json({ success: true, mensagem: `WhatsApp de teste enviado para ${destino}.` });
          return res.status(500).json({ success: false, mensagem: 'Falha Meta API: ' + JSON.stringify(json.error || json).slice(0, 200) });
        } catch (e) {
          return res.status(500).json({ success: false, mensagem: 'Erro ao enviar: ' + e.message });
        }
      }

      return res.status(400).json({ success: false, mensagem: 'Tipo de campanha inválido.' });
    }

    /* --- Importar contatos externos (CSV) --- */
    if (body.action === 'importar-contatos') {
      const { contatos, lista } = body;
      if (!Array.isArray(contatos) || !contatos.length)
        return res.status(400).json({ success: false, mensagem: 'Lista de contatos obrigatória.' });

      const listaNome = (lista || '').trim() || null;
      const rows = contatos
        .map(c => ({
          nome: (c.nome || '').trim(),
          email: (c.email || '').trim().toLowerCase() || null,
          telefone: (c.telefone || '').trim() || null,
          lista: listaNome,
          ativo: true,
        }))
        .filter(c => c.nome);

      if (!rows.length) return res.status(400).json({ success: false, mensagem: 'Nenhum contato válido.' });

      // Upsert: pula duplicatas de e-mail em vez de lançar erro
      const { data: inseridos, error } = await supabase
        .from('contatos_externos')
        .upsert(rows, { onConflict: 'email', ignoreDuplicates: true })
        .select('id');
      if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao importar: ' + error.message });
      const novos = (inseridos || []).length;
      const ignorados = rows.length - novos;
      const msg = ignorados > 0
        ? `${novos} importado(s). ${ignorados} já existia(m) e foram ignorado(s).`
        : `${novos} contato(s) importados.`;
      return res.status(200).json({ success: true, mensagem: msg, total: novos });
    }

    /* --- Listar contatos externos --- */
    if (body.action === 'listar-contatos') {
      const page  = parseInt(body.page  || 1);
      const limit = parseInt(body.limit || 50);
      const from  = (page - 1) * limit;
      let query = supabase
        .from('contatos_externos')
        .select('id, nome, email, telefone, lista, ativo, criado_em', { count: 'exact' })
        .order('criado_em', { ascending: false })
        .range(from, from + limit - 1);
      if (body.lista) query = query.eq('lista', body.lista);
      const { data, error, count } = await query;
      if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao listar contatos.' });
      return res.status(200).json({ success: true, contatos: data || [], total: count || 0, page, limit });
    }

    /* --- Listar nomes de listas --- */
    if (body.action === 'listar-listas') {
      const { data } = await supabase.from('contatos_externos').select('lista').not('lista', 'is', null);
      const listas = [...new Set((data || []).map(r => r.lista).filter(Boolean))].sort();
      return res.status(200).json({ success: true, listas });
    }

    /* --- Excluir todos os contatos de uma lista --- */
    if (body.action === 'excluir-lista') {
      const { lista } = body;
      if (!lista) return res.status(400).json({ success: false, mensagem: 'Nome da lista obrigatório.' });
      const { error } = await supabase.from('contatos_externos').delete().eq('lista', lista);
      if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao excluir lista: ' + error.message });
      return res.status(200).json({ success: true, mensagem: `Lista "${lista}" excluída.` });
    }

    /* --- Remover contato externo --- */
    if (body.action === 'remover-contato') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, mensagem: 'ID obrigatório.' });
      const { error } = await supabase.from('contatos_externos').delete().eq('id', id);
      if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao remover contato.' });
      return res.status(200).json({ success: true, mensagem: 'Contato removido.' });
    }

    /* --- Relatório de campanha --- */
    if (body.action === 'get-relatorio') {
      const { id, page = 1, limit = 100 } = body;
      if (!id) return res.status(400).json({ success: false, mensagem: 'ID obrigatório.' });

      const from = (page - 1) * limit;
      const { data, error, count } = await supabase
        .from('disparos')
        .select('id, destinatario, nome, status, enviado_em, aberto_em, clicado_em, erro', { count: 'exact' })
        .eq('campanha_id', id)
        .order('enviado_em', { ascending: false, nullsFirst: false })
        .range(from, from + limit - 1);

      if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao buscar relatório.' });

      const todos = data || [];
      const stats = {
        total:    count || 0,
        enviados: todos.filter(d => d.status === 'enviado').length,
        falhas:   todos.filter(d => d.status === 'falhou').length,
        pendentes:todos.filter(d => d.status === 'pendente').length,
        abertos:  todos.filter(d => d.aberto_em).length,
        clicados: todos.filter(d => d.clicado_em).length,
      };
      return res.status(200).json({ success: true, stats, disparos: todos, total: count || 0, page, limit });
    }

    /* --- Ler configurações --- */
    if (body.action === 'get-config') {
      const chaves = ['resend_key', 'resend_from', 'resend_from_marketing', 'whatsapp_token', 'whatsapp_phone_id', 'whatsapp_waba_id', 'base_url'];
      const cfg = await getConfigs(...chaves);
      const mascarar = (v) => v ? '••••••••' : '';
      return res.status(200).json({
        success: true,
        config: {
          resend_key:              mascarar(cfg.resend_key),
          resend_from:             cfg.resend_from             || '',
          resend_from_marketing:   cfg.resend_from_marketing   || '',
          whatsapp_token:          mascarar(cfg.whatsapp_token),
          whatsapp_phone_id:       cfg.whatsapp_phone_id       || '',
          whatsapp_waba_id:        cfg.whatsapp_waba_id        || '',
          base_url:                cfg.base_url                || '',
        },
      });
    }

    /* --- Salvar configurações --- */
    if (body.action === 'save-config') {
      const { config } = body;
      if (!config || typeof config !== 'object')
        return res.status(400).json({ success: false, mensagem: 'Config inválida.' });

      const permitidas = ['resend_key', 'resend_from', 'resend_from_marketing', 'whatsapp_token', 'whatsapp_phone_id', 'whatsapp_waba_id', 'base_url'];
      const upserts = Object.entries(config)
        .filter(([k, v]) => permitidas.includes(k) && v !== undefined)
        .map(([k, v]) => ({ chave: k, valor: String(v).trim(), atualizado_em: new Date().toISOString() }));

      if (!upserts.length) return res.status(400).json({ success: false, mensagem: 'Nenhum campo para salvar.' });

      const { error } = await supabase.from('configuracoes').upsert(upserts, { onConflict: 'chave' });
      if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao salvar: ' + error.message });
      return res.status(200).json({ success: true, mensagem: 'Configurações salvas.' });
    }

    /* --- Listar conversas WhatsApp --- */
    if (body.action === 'listar-conversas') {
      const { data, error } = await supabase
        .from('conversas')
        .select('id, telefone, nome, ultima_mensagem, ultima_mensagem_em, nao_lidas, criado_em')
        .order('ultima_mensagem_em', { ascending: false, nullsFirst: false });
      if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao listar conversas.' });
      return res.status(200).json({ success: true, conversas: data || [] });
    }

    /* --- Mensagens de uma conversa --- */
    if (body.action === 'get-mensagens') {
      const { conversa_id } = body;
      if (!conversa_id) return res.status(400).json({ success: false, mensagem: 'conversa_id obrigatório.' });
      const { data, error } = await supabase
        .from('mensagens')
        .select('id, direcao, conteudo, wamid, criado_em')
        .eq('conversa_id', conversa_id)
        .order('criado_em', { ascending: true });
      if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao buscar mensagens.' });
      await supabase.from('conversas').update({ nao_lidas: 0 }).eq('id', conversa_id);
      return res.status(200).json({ success: true, mensagens: data || [] });
    }

    /* --- Responder conversa WhatsApp --- */
    if (body.action === 'responder') {
      const { conversa_id, texto } = body;
      if (!conversa_id || !texto?.trim())
        return res.status(400).json({ success: false, mensagem: 'conversa_id e texto obrigatórios.' });
      const { data: conv } = await supabase.from('conversas').select('telefone').eq('id', conversa_id).single();
      if (!conv) return res.status(404).json({ success: false, mensagem: 'Conversa não encontrada.' });
      const cfg = await getConfigs('whatsapp_token', 'whatsapp_phone_id');
      const waToken = cfg.whatsapp_token || process.env.WHATSAPP_TOKEN;
      const phoneId = cfg.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
      if (!waToken || !phoneId)
        return res.status(503).json({ success: false, mensagem: 'Credenciais WhatsApp não configuradas.' });
      const tel = conv.telefone.replace(/\D/g, '');
      const numero = tel.startsWith('55') ? tel : '55' + tel;
      try {
        const resp = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: numero, type: 'text', text: { body: texto.trim() } }),
        });
        const json = await resp.json();
        const ok = !json.error && json.messages?.[0]?.id;
        if (!ok) return res.status(500).json({ success: false, mensagem: 'Erro Meta API: ' + JSON.stringify(json.error || json).slice(0, 200) });
        await supabase.from('mensagens').insert({
          conversa_id, direcao: 'saida', conteudo: texto.trim(), wamid: json.messages[0].id,
        });
        await supabase.from('conversas').update({
          ultima_mensagem: texto.trim(), ultima_mensagem_em: new Date().toISOString(),
        }).eq('id', conversa_id);
        return res.status(200).json({ success: true, mensagem: 'Mensagem enviada.' });
      } catch (e) {
        return res.status(500).json({ success: false, mensagem: 'Erro ao enviar: ' + e.message });
      }
    }

    /* --- Criar campanha --- */
    const { nome, tipo, publico, assunto, conteudo_html, conteudo_text, agendado_para, status, midia_url, midia_tipo, template_name, template_language } = body;
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
      conteudo_html:     conteudo_html     || null,
      conteudo_text:     conteudo_text     || null,
      agendado_para:     agendado_para     || null,
      midia_url:         midia_url         || null,
      midia_tipo:        midia_tipo        || null,
      template_name:     template_name     || null,
      template_language: template_language || null,
      status: statusFinal, ...extra,
    }).select('id').single();

    if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao criar campanha.' });
    return res.status(201).json({ success: true, id: data.id, mensagem: 'Campanha criada.' });
  }

  /* ── PATCH: atualizar campanha ── */
  if (req.method === 'PATCH') {
    const { id, status, nome, assunto, conteudo_html, conteudo_text, agendado_para, publico, midia_url, midia_tipo, template_name, template_language } = req.body || {};
    if (!id) return res.status(400).json({ success: false, mensagem: 'ID obrigatório.' });

    const { data: atual, error: fetchErr } = await supabase
      .from('campanhas').select('status').eq('id', id).single();
    if (fetchErr || !atual) return res.status(404).json({ success: false, mensagem: 'Campanha não encontrada.' });

    const campos = {};
    if (status && status !== atual.status) {
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
      if (midia_url        !== undefined) campos.midia_url      = midia_url       || null;
      if (midia_tipo       !== undefined) campos.midia_tipo     = midia_tipo      || null;
      if (template_name    !== undefined) campos.template_name  = template_name   || null;
      if (template_language!== undefined) campos.template_language = template_language || null;
    }
    if (!Object.keys(campos).length)
      return res.status(400).json({ success: false, mensagem: 'Nenhum campo para atualizar.' });

    const { error: updErr } = await supabase.from('campanhas').update(campos).eq('id', id);
    if (updErr) return res.status(500).json({ success: false, mensagem: 'Erro ao atualizar campanha.' });
    return res.status(200).json({ success: true, mensagem: 'Campanha atualizada.' });
  }

  /* ── DELETE: excluir campanha ── */
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, mensagem: 'ID obrigatório.' });
    await supabase.from('disparos').delete().eq('campanha_id', id);
    const { error } = await supabase.from('campanhas').delete().eq('id', id);
    if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao excluir: ' + error.message });
    return res.status(200).json({ success: true, mensagem: 'Campanha excluída.' });
  }

  return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });
};
