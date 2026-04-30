const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function autenticar(req) {
  try {
    // Aceita token via header Authorization OU via query param ?token=
    const token = (req.headers.authorization || '').replace('Bearer ', '')
      || (req.query && req.query.token) || '';
    jwt.verify(token, process.env.JWT_SECRET);
    return true;
  }
  catch { return false; }
}

function arrLabel(v) {
  if (!v) return '';
  try { const a = Array.isArray(v) ? v : JSON.parse(v); return a.join(' | '); } catch { return String(v); }
}

function fmtData(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function csvCell(v) {
  const s = String(v ?? '');
  if (s.includes(';') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

module.exports = async (req, res) => {
  if (!autenticar(req)) return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  // Aceita os mesmos filtros da listagem
  const { busca = '', uf = '', area = '', cert = '' } = req.query;

  let query = supabase.from('inscritos').select('*').order('criado_em', { ascending: true });
  if (busca) query = query.or(`nome_completo.ilike.%${busca}%,nome_social.ilike.%${busca}%,email.ilike.%${busca}%,cpf.ilike.%${busca}%`);
  if (uf)    query = query.eq('uf', uf);
  if (area)  query = query.contains('area_atuacao', [area]);
  if (cert === '1') query = query.eq('certificado_enviado', true);
  if (cert === '0') query = query.eq('certificado_enviado', false);

  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao consultar banco.' });

  const cabecalho = [
    'ID','Hash','Nome Completo','Nome Social','CPF','Data Nascimento',
    'E-mail','Telefone','Vínculo Pestalozzi','UF','Município',
    'Área de Atuação','Identidade de Gênero','Gênero Outro',
    'Formação Acadêmica','Como Soube','Como Soube Outro',
    'PCD','Descrição da Deficiência','Recurso de Acessibilidade',
    'Restrição Alimentar','Alergia Especificada',
    'Aceite LGPD','Aceite Imagem',
    'Certificado Enviado','Certificado Enviado Em','Inscrito Em',
  ];

  const linhas = data.map(ins => [
    ins.id, ins.hash,
    ins.nome_completo, ins.nome_social || '',
    ins.cpf,
    ins.data_nascimento ? new Date(ins.data_nascimento).toLocaleDateString('pt-BR') : '',
    ins.email, ins.telefone,
    ins.vinculo_pestalozzi ? 'Sim' : 'Não',
    ins.uf || '', ins.municipio || '',
    arrLabel(ins.area_atuacao),
    arrLabel(ins.identidade_genero), ins.genero_outro || '',
    ins.formacao || '',
    arrLabel(ins.como_soube), ins.como_soube_outro || '',
    ins.pcd ? 'Sim' : 'Não',
    ins.pcd_descricao || '', ins.pcd_recurso || '',
    arrLabel(ins.restricao_alimentar), ins.restricao_outro || '',
    ins.aceite_lgpd ? 'Sim' : 'Não',
    ins.aceite_imagem ? 'Sim' : 'Não',
    ins.certificado_enviado ? 'Sim' : 'Não',
    fmtData(ins.certificado_enviado_em),
    fmtData(ins.criado_em),
  ].map(csvCell).join(';'));

  const csv = '﻿' + [cabecalho.join(';'), ...linhas].join('\r\n');
  const filename = `inscritos_${new Date().toISOString().slice(0,10)}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
};
