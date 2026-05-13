const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const { Resend } = require('resend');
const jwt = require('jsonwebtoken');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend   = new Resend(process.env.RESEND_API_KEY);

const EVENTO_NOME  = process.env.EVENTO_NOME  || 'XVII Congresso Fenapestalozzi 2026';
const EVENTO_DATA  = process.env.EVENTO_DATA  || '10 a 13 de novembro de 2026';
const EVENTO_LOCAL = process.env.EVENTO_LOCAL || 'Complexo Brasil 21, Setor Hoteleiro Sul (SHS), Quadra 6 — Brasília, DF';
const MAPS_URL     = 'https://maps.app.goo.gl/WmNUSfaJKrJcvajr6';

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
  if (req.method !== 'POST') return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });
  if (!autenticar(req)) return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ success: false, mensagem: 'ID não informado.' });

  /* ── Buscar inscrito ── */
  const { data: ins, error } = await supabase.from('inscritos').select('*').eq('id', id).maybeSingle();
  if (error || !ins) return res.status(404).json({ success: false, mensagem: 'Inscrito não encontrado.' });

  const nome_exibir = ins.nome_social || ins.nome_completo;
  const cpf_exibido = cpfParcial(ins.cpf);
  const qr_url      = `${process.env.BASE_URL}/inscricao/?h=${ins.hash}`;
  const qrcode_url  = ins.qrcode_url || null;

  /* ── Enviar e-mail ── */
  try {
    const attachments = [];
    if (qrcode_url) {
      const qrBuf = await QRCode.toBuffer(qr_url, { type: 'png', width: 400, margin: 2, color: { dark: '#402B16' } });
      attachments.push({ filename: 'qrcode-credenciamento.png', content: qrBuf.toString('base64') });
    }

    await resend.emails.send({
      from: process.env.RESEND_FROM || `${EVENTO_NOME} <onboarding@resend.dev>`,
      to:   ins.email,
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

    return res.status(200).json({ success: true, mensagem: `Confirmação reenviada para ${ins.email}.` });
  } catch (e) {
    console.error('Reenviar confirmação error:', e.message);
    return res.status(500).json({ success: false, mensagem: 'Erro ao enviar e-mail. Tente novamente.' });
  }
};
