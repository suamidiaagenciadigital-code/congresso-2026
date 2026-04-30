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

function cpfParcial(cpf) {
  return cpf.replace(/^(\d{3})\.(\d{3})\.(\d{3})-(\d{2})$/, '***.***.$3-**');
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (!autenticar(req)) return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  const { busca = '', uf = '', area = '', cert = '' } = req.query;

  let query = supabase.from('inscritos').select('*').order('criado_em', { ascending: false });

  if (busca) query = query.or(`nome_completo.ilike.%${busca}%,nome_social.ilike.%${busca}%,email.ilike.%${busca}%,cpf.ilike.%${busca}%`);
  if (uf)    query = query.eq('uf', uf);
  if (area)  query = query.filter('area_atuacao::text', 'ilike', `%${area}%`);
  if (cert === '1') query = query.eq('certificado_enviado', true);
  if (cert === '0') query = query.eq('certificado_enviado', false);

  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao consultar banco.' });

  const { count: total }      = await supabase.from('inscritos').select('*', { count: 'exact', head: true });
  const { count: total_cert } = await supabase.from('inscritos').select('*', { count: 'exact', head: true }).eq('certificado_enviado', true);

  const dados = data.map(ins => ({
    id:                   ins.id,
    hash:                 ins.hash,
    nome_completo:        ins.nome_completo,
    nome_social:          ins.nome_social || '',
    cpf:                  ins.cpf,
    cpf_parcial:          cpfParcial(ins.cpf),
    data_nascimento:      ins.data_nascimento || '',
    email:                ins.email,
    telefone:             ins.telefone || '',
    vinculo_pestalozzi:   ins.vinculo_pestalozzi,
    uf:                   ins.uf || '',
    municipio:            ins.municipio || '',
    area_atuacao:         JSON.stringify(ins.area_atuacao || []),
    identidade_genero:    JSON.stringify(ins.identidade_genero || []),
    genero_outro:         ins.genero_outro || '',
    formacao:             ins.formacao || '',
    como_soube:           JSON.stringify(ins.como_soube || []),
    como_soube_outro:     ins.como_soube_outro || '',
    pcd:                  ins.pcd,
    pcd_descricao:        ins.pcd_descricao || '',
    pcd_recurso:          ins.pcd_recurso || '',
    restricao_alimentar:  JSON.stringify(ins.restricao_alimentar || []),
    restricao_outro:      ins.restricao_outro || '',
    aceite_lgpd:          ins.aceite_lgpd,
    aceite_imagem:        ins.aceite_imagem,
    certificado_enviado:  ins.certificado_enviado,
    certificado_enviado_em: ins.certificado_enviado_em || '',
    criado_em:            ins.criado_em,
  }));

  return res.status(200).json({ success: true, dados, total: total || 0, total_cert: total_cert || 0 });
};
