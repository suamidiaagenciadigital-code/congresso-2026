const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const { Resend } = require('resend');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend   = new Resend(process.env.RESEND_API_KEY);

const EVENTO_NOME  = process.env.EVENTO_NOME  || 'XVII Congresso Fenapestalozzi 2026';
const EVENTO_DATA  = process.env.EVENTO_DATA  || '10 a 13 de novembro de 2026';
const EVENTO_LOCAL = process.env.EVENTO_LOCAL || 'Complexo Brasil 21, Setor Hoteleiro Sul (SHS), Quadra 6 — Brasília, DF';
const EVENTO_HORA  = process.env.EVENTO_HORA  || 'das 08h às 18h';
const MAPS_URL     = 'https://maps.app.goo.gl/WmNUSfaJKrJcvajr6';

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

function cpfParcial(cpf) {
  return cpf.replace(/^(\d{3})\.(\d{3})\.(\d{3})-(\d{2})$/, '***.***.$3-**');
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });

  const d = req.body || {};

  /* ── reCAPTCHA ── */
  if (process.env.RECAPTCHA_SECRET) {
    const token = d.recaptcha || '';
    if (!token) return res.status(400).json({ success: false, mensagem: 'Confirme que você não é um robô.' });
    try {
      const verif = await fetch(
        `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${token}`,
        { method: 'POST' }
      );
      const result = await verif.json();
      if (!result.success) return res.status(400).json({ success: false, mensagem: 'Verificação reCAPTCHA falhou. Tente novamente.' });
    } catch (e) {
      console.error('reCAPTCHA error:', e.message);
    }
  }

  /* ── Validações ── */
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

  // UF e Município obrigatórios para todos
  const uf       = san(d.uf, 2);
  const municipio = san(d.municipio, 100);
  if (!uf)        return res.status(400).json({ success: false, mensagem: 'Informe o estado (UF).' });
  if (!municipio) return res.status(400).json({ success: false, mensagem: 'Informe o município.' });

  const pcd = parseInt(d.pcd);
  if (![0, 1].includes(pcd))
    return res.status(400).json({ success: false, mensagem: 'Informe se é PCD.' });

  if (parseInt(d.aceite_lgpd) !== 1)
    return res.status(400).json({ success: false, mensagem: 'Aceite os termos de uso.' });

  const area_atuacao = parseArr(d.area_atuacao);
  if (!area_atuacao.length)
    return res.status(400).json({ success: false, mensagem: 'Selecione ao menos uma área de atuação.' });

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

  /* ── CPF duplicado ── */
  const { data: existing } = await supabase.from('inscritos').select('id').eq('cpf', cpf).maybeSingle();
  if (existing) return res.status(409).json({ success: false, mensagem: 'Este CPF já está cadastrado. Verifique seu e-mail de confirmação.' });

  /* ── Gerar hash ── */
  const hash = crypto.createHash('md5').update(cpf_raw + email + Date.now()).digest('hex');

  /* ── Inserir no banco ── */
  const { error: insertError } = await supabase.from('inscritos').insert({
    hash, nome_completo, nome_social: nome_social || null, cpf,
    data_nascimento, email, telefone,
    vinculo_pestalozzi: vinculo === 1,
    uf, municipio,
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

  /* ── Webhook para sistema externo de credenciamento ── */
  if (process.env.WEBHOOK_URL) {
    const payload = {
      hash,
      nome: nome_completo,
      cpf,
      email,
      telefone,
      pcd: pcd === 1,
      pcd_descricao: pcd_descricao || null,
      vinculo_pestalozzi: vinculo === 1,
      uf,
      municipio,
      criado_em: new Date().toISOString(),
    };
    fetch(process.env.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.WEBHOOK_TOKEN && { 'Authorization': `Bearer ${process.env.WEBHOOK_TOKEN}` }),
      },
      body: JSON.stringify(payload),
    }).catch(e => console.error('Webhook error:', e.message));
  }

  /* ── Gerar e salvar QR Code ── */
  const qr_url    = `${process.env.BASE_URL}/inscricao/?h=${hash}`;
  let qrcode_url  = null;

  try {
    const qrBuffer = await QRCode.toBuffer(qr_url, { type: 'png', width: 400, margin: 2, color: { dark: '#402B16' } });
    const { error: upErr } = await supabase.storage.from('qrcodes').upload(`${hash}.png`, qrBuffer, { contentType: 'image/png', upsert: true });
    if (!upErr) {
      qrcode_url = supabase.storage.from('qrcodes').getPublicUrl(`${hash}.png`).data.publicUrl;
      await supabase.from('inscritos').update({ qrcode_url }).eq('hash', hash);
    }
  } catch (e) {
    console.error('QR code error:', e.message);
  }

  /* ── Enviar e-mail de confirmação ── */
  const nome_exibir  = nome_social || nome_completo;
  const cpf_exibido  = cpfParcial(cpf);

  try {
    const attachments = [];
    if (qrcode_url) {
      const qrBuf = await QRCode.toBuffer(qr_url, { type: 'png', width: 400, margin: 2, color: { dark: '#402B16' } });
      attachments.push({ filename: 'qrcode-credenciamento.png', content: qrBuf.toString('base64') });
    }

    await resend.emails.send({
      from: process.env.RESEND_FROM || `${EVENTO_NOME} <onboarding@resend.dev>`,
      to:   email,
      subject: `Inscrição confirmada — ${EVENTO_NOME}`,
      html: `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f5f9;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f9;padding:24px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

      <!-- Cabeçalho -->
      <tr>
        <td style="background:#402B16;border-radius:8px 8px 0 0;padding:24px 28px;text-align:center">
          <p style="margin:0 0 4px;color:rgba(255,255,255,.7);font-size:11px;letter-spacing:2px;text-transform:uppercase">Fenapestalozzi</p>
          <h1 style="margin:0;color:#ffffff;font-size:18px;line-height:1.4">${EVENTO_NOME}</h1>
          <p style="margin:6px 0 0;color:rgba(255,255,255,.8);font-size:13px">
            ${EVENTO_DATA} &bull; Brasília, DF
          </p>
        </td>
      </tr>

      <!-- Corpo -->
      <tr>
        <td style="background:#ffffff;padding:28px 32px">
          <p style="margin:0 0 6px;font-size:15px;color:#1a1a1a">
            Prezado(a) <strong>${nome_exibir}</strong>,
          </p>
          <p style="margin:0 0 18px;font-size:13px;color:#666">CPF ${cpf_exibido}</p>

          <p style="margin:0 0 16px;font-size:14px;color:#2d2d2d;line-height:1.6">
            confirmamos sua inscrição no evento: <strong>${EVENTO_NOME}</strong>,
            evento presencial, a ser realizado entre os dias
            <strong>${EVENTO_DATA}</strong>,
            em <strong>${EVENTO_LOCAL}</strong>.
          </p>

          <p style="margin:0 0 16px;font-size:14px;color:#2d2d2d;line-height:1.6">
            <strong>Atenção!</strong> Para agilizar o processo de credenciamento no dia do
            evento, apresente este <strong>QR Code da inscrição</strong> pelo celular
            (em anexo neste e-mail) ou
            <a href="${qr_url}" style="color:#1a5796;text-decoration:none;font-weight:bold">
              acesse sua página de inscrição aqui
            </a>.
          </p>

          ${qrcode_url ? `
          <div style="text-align:center;margin:24px 0">
            <img src="${qrcode_url}" alt="QR Code de credenciamento" width="180" height="180"
                 style="border:3px solid #e8ecf3;border-radius:8px;display:block;margin:0 auto">
            <p style="font-size:11px;color:#999;margin:8px 0 0">QR Code de credenciamento</p>
          </div>` : ''}

          <!-- Detalhes do evento -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f9;border-radius:6px;margin-top:20px">
            <tr>
              <td style="padding:14px 18px">
                <p style="margin:0 0 8px;font-size:12px;font-weight:bold;color:#402B16;text-transform:uppercase;letter-spacing:.5px">Detalhes do evento</p>
                <p style="margin:3px 0;font-size:13px;color:#444">📅 <strong>Data:</strong> ${EVENTO_DATA}</p>
                <p style="margin:3px 0;font-size:13px;color:#444">🌐 <strong>Programação:</strong> <a href="https://congressopestalozzi.org.br" style="color:#1a5796">congressopestalozzi.org.br</a></p>
                <p style="margin:3px 0;font-size:13px;color:#444">📍 <strong>Local:</strong> ${EVENTO_LOCAL}</p>
                <p style="margin:6px 0 0;font-size:12px">
                  <a href="${MAPS_URL}" style="color:#1a5796">Ver no Google Maps →</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Rodapé -->
      <tr>
        <td style="background:#f2f5f9;border-radius:0 0 8px 8px;padding:16px 28px;text-align:center;border-top:1px solid #dde3ed">
          <p style="margin:0;font-size:11px;color:#999;line-height:1.6">
            <strong>${EVENTO_NOME}</strong><br>
            Fenapestalozzi — Federação Nacional das APAEs Pestalozzi<br>
            Este é um e-mail automático. Não responda a esta mensagem.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`,
      attachments,
    });
  } catch (e) {
    console.error('Resend error:', e.message);
    // Inscrição já salva — e-mail falhou silenciosamente
  }

  return res.status(200).json({ success: true, hash, mensagem: 'Inscrição realizada com sucesso!' });
};
