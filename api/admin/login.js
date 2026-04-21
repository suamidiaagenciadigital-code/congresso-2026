const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });

  const { usuario, senha } = req.body || {};
  if (usuario !== process.env.ADMIN_USER || senha !== process.env.ADMIN_PASS)
    return res.status(401).json({ success: false, mensagem: 'Usuário ou senha incorretos.' });

  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '2h' });
  return res.status(200).json({ success: true, token });
};
