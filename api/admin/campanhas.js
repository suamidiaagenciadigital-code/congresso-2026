const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function autenticar(req) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    jwt.verify(token, process.env.JWT_SECRET);
    return true;
  } catch { return false; }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (!autenticar(req)) return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  /* ── GET: listar campanhas ── */
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('campanhas')
      .select('id, nome, tipo, publico, assunto, status, agendado_para, aprovado_por, aprovado_em, iniciado_em, concluido_em, criado_em')
      .order('criado_em', { ascending: false });

    if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao consultar campanhas.' });

    const stats = {};
    data.forEach(c => { stats[c.status] = (stats[c.status] || 0) + 1; });

    return res.status(200).json({ success: true, total: data.length, stats, campanhas: data });
  }

  /* ── POST: criar campanha ── */
  if (req.method === 'POST') {
    const { nome, tipo, publico, assunto, conteudo_html, conteudo_text, agendado_para, status } = req.body || {};

    if (!nome || !tipo || !publico)
      return res.status(400).json({ success: false, mensagem: 'Campos obrigatórios: nome, tipo, publico.' });
    if (!['email', 'whatsapp'].includes(tipo))
      return res.status(400).json({ success: false, mensagem: 'Tipo inválido.' });
    if (!['inscritos', 'externos'].includes(publico))
      return res.status(400).json({ success: false, mensagem: 'Público inválido.' });
    if (tipo === 'email' && !assunto)
      return res.status(400).json({ success: false, mensagem: 'Assunto obrigatório para campanhas de e-mail.' });

    const statusFinal = ['rascunho', 'aguardando_aprovacao'].includes(status) ? status : 'rascunho';

    const { data, error } = await supabase.from('campanhas').insert({
      nome: nome.trim(),
      tipo,
      publico,
      assunto: assunto?.trim() || null,
      conteudo_html: conteudo_html || null,
      conteudo_text: conteudo_text || null,
      agendado_para: agendado_para || null,
      status: statusFinal,
    }).select('id').single();

    if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao criar campanha.' });
    return res.status(201).json({ success: true, id: data.id, mensagem: 'Campanha criada.' });
  }

  /* ── PATCH: atualizar campanha (editar conteúdo ou mudar status) ── */
  if (req.method === 'PATCH') {
    const { id, status, nome, assunto, conteudo_html, conteudo_text, agendado_para, publico } = req.body || {};

    if (!id) return res.status(400).json({ success: false, mensagem: 'ID obrigatório.' });

    const { data: atual, error: fetchErr } = await supabase
      .from('campanhas').select('status').eq('id', id).single();

    if (fetchErr || !atual) return res.status(404).json({ success: false, mensagem: 'Campanha não encontrada.' });

    const campos = {};

    if (status) {
      const transicoesValidas = {
        rascunho:              ['aguardando_aprovacao', 'cancelado'],
        aguardando_aprovacao:  ['aprovado', 'rascunho', 'cancelado'],
        aprovado:              ['cancelado'],
      };
      const permitidos = transicoesValidas[atual.status] || [];
      if (!permitidos.includes(status))
        return res.status(400).json({ success: false, mensagem: `Transição inválida: ${atual.status} → ${status}` });

      campos.status = status;
      if (status === 'aprovado') {
        campos.aprovado_em = new Date().toISOString();
        campos.aprovado_por = 'admin';
      }
    }

    if (atual.status === 'rascunho') {
      if (nome)          campos.nome          = nome.trim();
      if (assunto)       campos.assunto       = assunto.trim();
      if (conteudo_html !== undefined) campos.conteudo_html = conteudo_html;
      if (conteudo_text !== undefined) campos.conteudo_text = conteudo_text;
      if (agendado_para !== undefined) campos.agendado_para = agendado_para || null;
      if (publico)       campos.publico       = publico;
    }

    if (!Object.keys(campos).length)
      return res.status(400).json({ success: false, mensagem: 'Nenhum campo para atualizar.' });

    const { error: updErr } = await supabase.from('campanhas').update(campos).eq('id', id);
    if (updErr) return res.status(500).json({ success: false, mensagem: 'Erro ao atualizar campanha.' });

    return res.status(200).json({ success: true, mensagem: 'Campanha atualizada.' });
  }

  return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });
};
