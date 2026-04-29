const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function autenticar(req) {
  try { jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET); return true; }
  catch { return false; }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });
  if (!autenticar(req))     return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ success: false, mensagem: 'ID inválido.' });

  const { error } = await supabase.from('inscritos').delete().eq('id', parseInt(id));
  if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao remover inscrito.' });

  return res.status(200).json({ success: true, mensagem: 'Inscrito removido com sucesso.' });
};
