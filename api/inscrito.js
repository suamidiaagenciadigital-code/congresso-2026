const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function cpfParcial(cpf) {
  // Formato: 000.000.000-00  →  ***.***.[3dígitos]-**
  return cpf.replace(/^(\d{3})\.(\d{3})\.(\d{3})-(\d{2})$/, '***.***.***-**').replace(/\*{3}\.\*{3}\.(\d{3})-\*{2}/, '***.***.$1-**');
}

module.exports = async (req, res) => {
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
