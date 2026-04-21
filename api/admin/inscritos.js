const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function autenticar(req) {
  try {
    const header = req.headers.authorization || '';
    const token  = header.replace('Bearer ', '');
    jwt.verify(token, process.env.JWT_SECRET);
    return true;
  } catch { return false; }
}

function cpfParcial(cpf) {
  return cpf.replace(/^(\d{3})\.(\d{3})\.(\d{3})-(\d{2})$/, '***.***.$3-**');
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (!autenticar(req)) return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  const { busca = '', uf = '', area = '', cert = '' } = req.query;

  let query = supabase.from('inscritos').select('*').order('criado_em', { ascending: false });

  if (busca) {
    query = query.or(`nome_completo.ilike.%${busca}%,nome_social.ilike.%${busca}%,email.ilike.%${busca}%,cpf.ilike.%${busca}%`);
  }
  if (uf)   query = query.eq('uf', uf);
  if (area) query = query.contains('area_atuacao', [area]);
  if (cert === '1') query = query.eq('certificado_enviado', true);
  if (cert === '0') query = query.eq('certificado_enviado', false);

  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao consultar banco.' });

  // Contadores gerais (sem filtro)
  const { count: total }      = await supabase.from('inscritos').select('*', { count: 'exact', head: true });
  const { count: total_cert } = await supabase.from('inscritos').select('*', { count: 'exact', head: true }).eq('certificado_enviado', true);

  const dados = data.map(ins => ({
    id:                  ins.id,
    nome_completo:       ins.nome_completo,
    nome_social:         ins.nome_social,
    cpf_parcial:         cpfParcial(ins.cpf),
    email:               ins.email,
    uf:                  ins.uf,
    area_atuacao:        JSON.stringify(ins.area_atuacao || []),
    pcd:                 ins.pcd,
    certificado_enviado: ins.certificado_enviado,
    criado_em:           ins.criado_em,
  }));

  return res.status(200).json({ success: true, dados, total: total || 0, total_cert: total_cert || 0 });
};
