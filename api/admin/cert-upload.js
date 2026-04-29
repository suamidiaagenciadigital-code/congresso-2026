const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function autenticar(req) {
  try { jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET); return true; }
  catch { return false; }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ success: false });
  if (!autenticar(req)) return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  const { dados, tipo } = req.body || {};

  if (!dados || !['image/jpeg', 'image/png'].includes(tipo)) {
    return res.status(400).json({ success: false, mensagem: 'Envie um arquivo JPG ou PNG válido.' });
  }

  const ext = tipo === 'image/jpeg' ? 'jpg' : 'png';
  const filename = `certificado-template.${ext}`;
  const buffer = Buffer.from(dados, 'base64');

  if (buffer.length > 4 * 1024 * 1024) {
    return res.status(400).json({ success: false, mensagem: 'Arquivo muito grande. Máximo: 4 MB.' });
  }

  // Remove template anterior (ambos os formatos)
  await supabase.storage.from('templates').remove(['certificado-template.jpg', 'certificado-template.png']).catch(() => {});

  const { error: upErr } = await supabase.storage
    .from('templates')
    .upload(filename, buffer, { contentType: tipo, upsert: true });

  if (upErr) return res.status(500).json({ success: false, mensagem: 'Erro no upload: ' + upErr.message });

  const { data } = supabase.storage.from('templates').getPublicUrl(filename);

  // Salva URL nas configurações
  await supabase.from('configuracoes').upsert(
    { chave: 'cert_arte_url', valor: data.publicUrl, atualizado_em: new Date().toISOString() },
    { onConflict: 'chave' }
  );

  return res.status(200).json({ success: true, url: data.publicUrl });
};
