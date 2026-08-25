const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  /* ── Autenticação por API Key ── */
  const auth = req.headers['authorization'] || '';
  const key  = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-api-key'] || '');
  if (!process.env.SYNC_API_KEY || key !== process.env.SYNC_API_KEY)
    return res.status(401).json({ error: 'Unauthorized.' });

  /* ── Filtro opcional por data ── */
  const desde = req.query.desde;

  let query = supabase
    .from('inscritos')
    .select('hash, nome_completo, cpf, email, telefone, pcd, pcd_descricao, vinculo_pestalozzi, uf, municipio, criado_em')
    .order('criado_em', { ascending: true });

  if (desde) {
    const dt = new Date(desde);
    if (isNaN(dt.getTime()))
      return res.status(400).json({ error: 'Parâmetro "desde" inválido. Use formato ISO 8601 (ex: 2026-08-25T00:00:00Z).' });
    query = query.gte('criado_em', dt.toISOString());
  }

  const { data, error } = await query;

  if (error) {
    console.error('Sync query error:', error);
    return res.status(500).json({ error: 'Erro interno ao consultar inscritos.' });
  }

  const inscritos = data.map(r => ({
    hash:                r.hash,
    nome:                r.nome_completo,
    cpf:                 r.cpf,
    email:               r.email,
    telefone:            r.telefone,
    pcd:                 r.pcd,
    pcd_descricao:       r.pcd_descricao || null,
    vinculo_pestalozzi:  r.vinculo_pestalozzi,
    uf:                  r.uf,
    municipio:           r.municipio,
    criado_em:           r.criado_em,
  }));

  return res.status(200).json({ total: inscritos.length, inscritos });
};
