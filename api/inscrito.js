const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function cpfParcial(cpf) {
  // Formato: 000.000.000-00  →  ***.***.[3dígitos]-**
  return cpf.replace(/^(\d{3})\.(\d{3})\.(\d{3})-(\d{2})$/, '***.***.***-**').replace(/\*{3}\.\*{3}\.(\d{3})-\*{2}/, '***.***.$1-**');
}

module.exports = async (req, res) => {

  /* ── Webhook Meta Cloud API — verificação (GET hub.challenge) ── */
  if (req.method === 'GET' && req.query['hub.mode'] === 'subscribe') {
    const verifyToken = process.env.WHATSAPP_WEBHOOK_TOKEN || 'congresso2026';
    if (req.query['hub.verify_token'] === verifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    return res.status(403).end();
  }

  /* ── Webhook Meta Cloud API — mensagens recebidas (POST) ── */
  if (req.method === 'POST') {
    try {
      const payload = req.body || {};
      for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;
          for (const msg of value?.messages || []) {
            const from  = msg.from;
            const wamid = msg.id;
            const nome  = value.contacts?.[0]?.profile?.name || from;
            let conteudo;
            if      (msg.type === 'text')     conteudo = msg.text?.body;
            else if (msg.type === 'image')    conteudo = msg.image?.caption || '[Imagem]';
            else if (msg.type === 'audio')    conteudo = '[Áudio]';
            else if (msg.type === 'video')    conteudo = msg.video?.caption || '[Vídeo]';
            else if (msg.type === 'document') conteudo = '[Documento]';
            else                              conteudo = `[${msg.type}]`;

            const { data: conv } = await supabase
              .from('conversas')
              .upsert(
                { telefone: from, nome, ultima_mensagem: conteudo, ultima_mensagem_em: new Date().toISOString() },
                { onConflict: 'telefone' }
              )
              .select('id, nao_lidas')
              .single();

            if (conv) {
              await supabase.from('conversas')
                .update({ nao_lidas: (conv.nao_lidas || 0) + 1 })
                .eq('id', conv.id);
              await supabase.from('mensagens').insert({
                conversa_id: conv.id, direcao: 'entrada', conteudo, wamid,
              });
            }
          }
        }
      }
    } catch (e) { console.error('Webhook error:', e); }
    return res.status(200).json({ success: true });
  }

  /* ── Pixel de rastreamento de abertura e clique ── */
  if (req.query.acao === 'track') {
    const { c: campId, e: email, t: tipo, url } = req.query;
    if (campId && email && tipo) {
      const campo = tipo === 'open' ? 'aberto_em' : 'clicado_em';
      await supabase.from('disparos')
        .update({ [campo]: new Date().toISOString() })
        .eq('campanha_id', campId)
        .eq('destinatario', decodeURIComponent(email))
        .is(campo, null);
    }
    if (tipo === 'click' && url) {
      res.setHeader('Location', decodeURIComponent(url));
      return res.status(302).end();
    }
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return res.status(200).send(gif);
  }

  res.setHeader('Content-Type', 'application/json');

  const hash = (req.query.h || '').replace(/[^a-f0-9]/g, '');
  if (hash.length !== 32)
    return res.status(400).json({ success: false, mensagem: 'Hash inválido.' });

  const { data: ins, error } = await supabase
    .from('inscritos')
    .select('nome_completo, nome_social, cpf, qrcode_url, criado_em')
    .eq('hash', hash)
    .maybeSingle();

  if (error || !ins)
    return res.status(404).json({ success: false, mensagem: 'Inscrição não encontrada.' });

  const nome = ins.nome_social || ins.nome_completo;
  const data_inscricao = new Date(ins.criado_em).toLocaleDateString('pt-BR');

  return res.status(200).json({
    success: true,
    dados: {
      nome,
      cpf_parcial:  cpfParcial(ins.cpf),
      qrcode_url:   ins.qrcode_url || null,
      data_inscricao,
    },
  });
};
