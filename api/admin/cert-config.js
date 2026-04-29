const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function autenticar(req) {
  try { jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET); return true; }
  catch { return false; }
}

const CHAVES = ['cert_arte_url', 'cert_nome_y', 'cert_nome_tamanho', 'cert_nome_cor'];

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (!autenticar(req)) return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('configuracoes')
      .select('chave, valor')
      .in('chave', CHAVES);

    if (error) return res.status(200).json({ success: true, config: {} });

    const config = {};
    (data || []).forEach(r => { config[r.chave] = r.valor; });
    return res.status(200).json({ success: true, config });
  }

  if (req.method === 'POST') {
    const updates = req.body || {};
    const upserts = [];
    for (const [chave, valor] of Object.entries(updates)) {
      if (CHAVES.includes(chave)) {
        upserts.push({ chave, valor: String(valor), atualizado_em: new Date().toISOString() });
      }
    }
    if (upserts.length) {
      const { error } = await supabase
        .from('configuracoes')
        .upsert(upserts, { onConflict: 'chave' });
      if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao salvar: ' + error.message });
    }
    return res.status(200).json({ success: true, mensagem: 'Configurações salvas.' });
  }

  return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });
};
