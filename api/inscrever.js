const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const { Resend } = require('resend');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend   = new Resend(process.env.RESEND_API_KEY);

function validarCPF(cpf) {
  cpf = cpf.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += parseInt(cpf[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== parseInt(cpf[t])) return false;
  }
  return true;
}

function san(v, max = 300) {
  if (typeof v !== 'string') return '';
  return v.trim().replace(/<[^>]*>/g, '').slice(0, max);
}

function parseArr(v) {
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });

  const d = req.body || {};

  // ── Validações ────────────────────────────────────────────────────────────
  const nome_completo = san(d.nome_completo, 200);
  if (nome_completo.length < 5)
    return res.status(400).json({ success: false, mensagem: 'Nome inválido (mínimo 5 caracteres).' });

  const cpf_raw = (d.cpf || '').replace(/\D/g, '');
  if (!validarCPF(cpf_raw))
    return res.status(400).json({ success: false, mensagem: 'CPF inválido.' });
  const cpf = cpf_raw.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

  const email = san(d.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ success: false, mensagem: 'E-mail inválido.' });

  const telefone = san(d.telefone, 20);
  if (telefone.replace(/\D/g, '').length < 10)
    return res.status(400).json({ success: false, mensagem: 'Telefone inválido.' });

  const vinculo = parseInt(d.vinculo_pestalozzi);
  if (![0, 1].includes(vinculo))
    return res.status(400).json({ success: false, mensagem: 'Informe o vínculo com a Pestalozzi.' });

  const pcd = parseInt(d.pcd);
  if (![0, 1].includes(pcd))
    return res.status(400).json({ success: false, mensagem: 'Informe se é PCD.' });

  if (parseInt(d.aceite_lgpd) !== 1)
    return res.status(400).json({ success: false, mensagem: 'Aceite os termos de uso.' });

  const area_atuacao = parseArr(d.area_atuacao);
  if (!area_atuacao.length)
    return res.status(400).json({ success: false, mensagem: 'Selecione ao menos uma área de atuação.' });

  let uf = '', municipio = '';
  if (vinculo === 1) {
    uf = san(d.uf, 2);
    municipio = san(d.municipio, 100);
    if (!uf)       return res.status(400).json({ success: false, mensagem: 'Informe o estado (UF).' });
    if (!municipio) return res.status(400).json({ success: false, mensagem: 'Informe o município.' });
  }

  let pcd_descricao = '', pcd_recurso = '';
  if (pcd === 1) {
    pcd_descricao = san(d.pcd_descricao, 300);
    pcd_recurso   = san(d.pcd_recurso, 300);
    if (!pcd_descricao) return res.status(400).json({ success: false, mensagem: 'Descreva a deficiência.' });
    if (!pcd_recurso)   return res.status(400).json({ success: false, mensagem: 'Informe o recurso de acessibilidade.' });
  }

  const nome_social         = san(d.nome_social, 200);
  const data_nascimento     = /^\d{4}-\d{2}-\d{2}$/.test(d.data_nascimento || '') ? d.data_nascimento : null;
  const identidade_genero   = parseArr(d.identidade_genero);
  const genero_outro        = san(d.genero_outro, 100);
  const formacao            = san(d.formacao, 50);
  const como_soube          = parseArr(d.como_soube);
  const como_soube_outro    = san(d.como_soube_outro, 100);
  const restricao_alimentar = parseArr(d.restricao_alimentar);
  const restricao_outro     = san(d.restricao_outro, 100);
  const aceite_imagem       = parseInt(d.aceite_imagem) === 1;

  // ── CPF duplicado ─────────────────────────────────────────────────────────
  const { data: existing } = await supabase.from('inscritos').select('id').eq('cpf', cpf).maybeSingle();
  if (existing) return res.status(409).json({ success: false, mensagem: 'Este CPF já está cadastrado. Verifique seu e-mail.' });

  // ── Gerar hash ────────────────────────────────────────────────────────────
  const hash = crypto.createHash('md5').update(cpf_raw + email + Date.now()).digest('hex');

  // ── Inserir no banco ──────────────────────────────────────────────────────
  const { error: insertError } = await supabase.from('inscritos').insert({
    hash, nome_completo, nome_social: nome_social || null, cpf,
    data_nascimento, email, telefone,
    vinculo_pestalozzi: vinculo === 1,
    uf: uf || null, municipio: municipio || null,
    area_atuacao, identidade_genero, genero_outro: genero_outro || null,
    formacao: formacao || null, como_soube, como_soube_outro: como_soube_outro || null,
    pcd: pcd === 1, pcd_descricao: pcd_descricao || null, pcd_recurso: pcd_recurso || null,
    restricao_alimentar, restricao_outro: restricao_outro || null,
    aceite_lgpd: true, aceite_imagem,
  });

  if (insertError) {
    console.error('Supabase insert error:', insertError);
    return res.status(500).json({ success: false, mensagem: 'Erro ao salvar inscrição. Tente novamente.' });
  }

  // ── Gerar e salvar QR Code ────────────────────────────────────────────────
  const qr_url = `${process.env.BASE_URL}/inscricao/${hash}`;
  let qrcode_url = null;

  try {
    const qrBuffer = await QRCode.toBuffer(qr_url, { type: 'png', width: 400, margin: 2, color: { dark: '#1a5276' } });
    const { error: upErr } = await supabase.storage.from('qrcodes').upload(`${hash}.png`, qrBuffer, { contentType: 'image/png', upsert: true });
    if (!upErr) {
      qrcode_url = supabase.storage.from('qrcodes').getPublicUrl(`${hash}.png`).data.publicUrl;
      await supabase.from('inscritos').update({ qrcode_url }).eq('hash', hash);
    }
  } catch (e) {
    console.error('QR code error:', e.message);
  }

  // ── Enviar e-mail de confirmação ──────────────────────────────────────────
  const nome_exibir = nome_social || nome_completo;
  const eventoNome  = process.env.EVENTO_NOME || 'Congresso Fenapestalozzi 2026';
  const eventoData  = process.env.EVENTO_DATA || '';

  try {
    const attachments = [];
    if (qrcode_url) {
      const qrBuf = await QRCode.toBuffer(qr_url, { type: 'png', width: 400, margin: 2, color: { dark: '#1a5276' } });
      attachments.push({ filename: 'qrcode-credenciamento.png', content: qrBuf.toString('base64') });
    }

    await resend.emails.send({
      from: process.env.RESEND_FROM || `${eventoNome} <onboarding@resend.dev>`,
      to:   email,
      subject: `Inscrição confirmada — ${eventoNome}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2 style="color:#1a5276;margin-bottom:16px">✅ Inscrição confirmada!</h2>
          <p style="margin-bottom:12px">Olá, <strong>${nome_exibir}</strong>!</p>
          <p style="margin-bottom:12px">Sua inscrição no <strong>${eventoNome}</strong> foi confirmada com sucesso.</p>
          <p style="margin-bottom:12px">Em anexo está o seu <strong>QR Code de credenciamento</strong>. Apresente-o na entrada do evento — pode ser pelo celular ou impresso.</p>
          <p style="margin-bottom:24px">Você também pode acessar sua página de inscrição pelo link:<br>
            <a href="${qr_url}" style="color:#1a5276">${qr_url}</a></p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#999;font-size:.85rem">${eventoNome} &mdash; ${eventoData}</p>
        </div>`,
      attachments,
    });
  } catch (e) {
    console.error('Resend error:', e.message);
    // Inscrição já salva — e-mail falhou silenciosamente
  }

  return res.status(200).json({ success: true, hash, mensagem: 'Inscrição realizada com sucesso!' });
};
