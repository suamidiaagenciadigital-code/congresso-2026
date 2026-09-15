const { createClient } = require('@supabase/supabase-js');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function verificarToken(req) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  /* ── POST sem action = login ── */
  if (req.method === 'POST' && !req.body?.action) {
    const { usuario, senha } = req.body || {};
    if (!usuario || !senha)
      return res.status(400).json({ success: false, mensagem: 'Informe usuário e senha.' });

    // Verifica se há admins cadastrados na tabela
    const { count } = await supabase
      .from('admins').select('*', { count: 'exact', head: true });

    if (count === 0) {
      // Tabela vazia: usa variáveis de ambiente (compatibilidade com acesso inicial)
      if (usuario !== process.env.ADMIN_USER || senha !== process.env.ADMIN_PASS)
        return res.status(401).json({ success: false, mensagem: 'Usuário ou senha incorretos.' });

      const token = jwt.sign({ admin: true, usuario }, process.env.JWT_SECRET, { expiresIn: '8h' });
      return res.status(200).json({
        success: true, token,
        aviso: 'Acesso via variáveis de ambiente. Crie um administrador na aba "Equipe" para encerrar essa dependência.',
      });
    }

    // Tabela com registros: autenticação pelo banco
    const { data: admin } = await supabase
      .from('admins').select('*').eq('usuario', usuario.trim().toLowerCase()).eq('ativo', true).single();

    if (!admin || !(await bcrypt.compare(senha, admin.senha_hash)))
      return res.status(401).json({ success: false, mensagem: 'Usuário ou senha incorretos.' });

    await supabase.from('admins').update({ ultimo_acesso: new Date().toISOString() }).eq('id', admin.id);
    const token = jwt.sign({ admin: true, usuario: admin.usuario, id: admin.id }, process.env.JWT_SECRET, { expiresIn: '8h' });
    return res.status(200).json({ success: true, token });
  }

  /* ── Demais rotas requerem autenticação ── */
  const session = verificarToken(req);
  if (!session) return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  /* ── GET: listar administradores ── */
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('admins')
      .select('id, nome, usuario, ativo, criado_em, ultimo_acesso')
      .order('criado_em', { ascending: true });
    if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao consultar administradores.' });
    return res.status(200).json({ success: true, admins: data });
  }

  /* ── POST action='criar': novo administrador ── */
  if (req.method === 'POST' && req.body?.action === 'criar') {
    const { nome, usuario, senha } = req.body;
    if (!nome || !usuario || !senha)
      return res.status(400).json({ success: false, mensagem: 'Nome, usuário e senha são obrigatórios.' });
    if (senha.length < 8)
      return res.status(400).json({ success: false, mensagem: 'A senha deve ter no mínimo 8 caracteres.' });

    const hash = await bcrypt.hash(senha, 12);
    const { error } = await supabase.from('admins').insert({
      nome: nome.trim(),
      usuario: usuario.trim().toLowerCase(),
      senha_hash: hash,
    });
    if (error) {
      if (error.code === '23505')
        return res.status(409).json({ success: false, mensagem: 'Esse usuário já existe.' });
      return res.status(500).json({ success: false, mensagem: 'Erro ao criar administrador.' });
    }
    return res.status(201).json({ success: true, mensagem: 'Administrador criado com sucesso.' });
  }

  /* ── PATCH: atualizar nome, senha ou status ── */
  if (req.method === 'PATCH') {
    const { id, nome, senha, ativo } = req.body || {};
    if (!id) return res.status(400).json({ success: false, mensagem: 'ID obrigatório.' });

    const campos = {};
    if (nome !== undefined) campos.nome = nome.trim();
    if (ativo !== undefined) {
      // Impede desativar o único admin ativo
      if (!ativo) {
        const { count: ativos } = await supabase
          .from('admins').select('*', { count: 'exact', head: true }).eq('ativo', true);
        if (ativos <= 1)
          return res.status(400).json({ success: false, mensagem: 'Não é possível desativar o único administrador ativo.' });
      }
      campos.ativo = ativo;
    }
    if (senha !== undefined) {
      if (senha.length < 8)
        return res.status(400).json({ success: false, mensagem: 'A senha deve ter no mínimo 8 caracteres.' });
      campos.senha_hash = await bcrypt.hash(senha, 12);
    }
    if (!Object.keys(campos).length)
      return res.status(400).json({ success: false, mensagem: 'Nenhum campo para atualizar.' });

    const { error } = await supabase.from('admins').update(campos).eq('id', id);
    if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao atualizar administrador.' });
    return res.status(200).json({ success: true, mensagem: 'Administrador atualizado.' });
  }

  /* ── DELETE: remover administrador ── */
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, mensagem: 'ID obrigatório.' });

    const { count: ativos } = await supabase
      .from('admins').select('*', { count: 'exact', head: true }).eq('ativo', true);
    if (ativos <= 1)
      return res.status(400).json({ success: false, mensagem: 'Não é possível remover o único administrador ativo.' });

    const { error } = await supabase.from('admins').delete().eq('id', id);
    if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao remover administrador.' });
    return res.status(200).json({ success: true, mensagem: 'Administrador removido.' });
  }

  return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });
};
