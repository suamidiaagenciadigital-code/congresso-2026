const { createClient } = require('@supabase/supabase-js');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { Resend } = require('resend');
const jwt = require('jsonwebtoken');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend   = new Resend(process.env.RESEND_API_KEY);

function autenticar(req) {
  try { jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET); return true; }
  catch { return false; }
}

async function gerarCertificadoPDF(nome, eventoData) {
  const pdfDoc = await PDFDocument.create();

  // A4 paisagem em pontos (1mm ≈ 2.835pt): 297mm × 210mm
  const largura = 841.89;
  const altura  = 595.28;
  const page    = pdfDoc.addPage([largura, altura]);

  // Arte de fundo (se configurada)
  if (process.env.CERT_ARTE_URL) {
    try {
      const imgResp = await fetch(process.env.CERT_ARTE_URL);
      if (imgResp.ok) {
        const imgBytes  = await imgResp.arrayBuffer();
        const url = process.env.CERT_ARTE_URL.toLowerCase();
        const img = url.endsWith('.jpg') || url.endsWith('.jpeg')
          ? await pdfDoc.embedJpg(imgBytes)
          : await pdfDoc.embedPng(imgBytes);
        page.drawImage(img, { x: 0, y: 0, width: largura, height: altura });
      }
    } catch (e) {
      console.error('Arte do certificado não carregada:', e.message);
    }
  }

  // Fonte
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Posições em pontos (configuráveis via env)
  const nomeY = parseFloat(process.env.CERT_NOME_Y || '325');
  const dataY = parseFloat(process.env.CERT_DATA_Y || '283');

  // Nome do participante — centralizado
  const tamNome = 36;
  const nomeW   = fontBold.widthOfTextAtSize(nome, tamNome);
  page.drawText(nome, {
    x:    (largura - nomeW) / 2,
    y:    nomeY,
    size: tamNome,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.1),
  });

  // Data do evento — centralizado
  const tamData = 18;
  const dataW   = font.widthOfTextAtSize(eventoData, tamData);
  page.drawText(eventoData, {
    x:    (largura - dataW) / 2,
    y:    dataY,
    size: tamData,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });

  return Buffer.from(await pdfDoc.save());
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });
  if (!autenticar(req))      return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  const { modo, id } = req.body || {};
  if (!['todos', 'individual'].includes(modo))
    return res.status(400).json({ success: false, mensagem: 'Modo inválido.' });

  // Buscar inscritos
  let query = supabase.from('inscritos').select('*');
  if (modo === 'todos')       query = query.eq('certificado_enviado', false);
  else if (modo === 'individual') query = query.eq('id', parseInt(id));

  const { data: inscritos, error } = await query;
  if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao consultar banco.' });
  if (!inscritos?.length) return res.status(200).json({ success: true, enviados: 0, mensagem: 'Nenhum inscrito pendente.' });

  const eventoNome = process.env.EVENTO_NOME || 'Congresso Fenapestalozzi 2026';
  const eventoData = process.env.EVENTO_DATA || '';

  let enviados = 0, erros = 0;

  for (const ins of inscritos) {
    const nome = ins.nome_social || ins.nome_completo;
    try {
      const pdfBuffer = await gerarCertificadoPDF(nome, eventoData);

      await resend.emails.send({
        from: process.env.RESEND_FROM || `${eventoNome} <onboarding@resend.dev>`,
        to:   ins.email,
        subject: `Seu certificado — ${eventoNome}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
            <h2 style="color:#1a5276;margin-bottom:16px">🎓 Seu certificado de participação</h2>
            <p style="margin-bottom:12px">Olá, <strong>${nome}</strong>!</p>
            <p style="margin-bottom:12px">Obrigado por participar do <strong>${eventoNome}</strong>.</p>
            <p style="margin-bottom:24px">Em anexo está o seu <strong>certificado de participação</strong>.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
            <p style="color:#999;font-size:.85rem">${eventoNome} &mdash; ${eventoData}</p>
          </div>`,
        attachments: [{
          filename: `certificado-${ins.hash}.pdf`,
          content:  pdfBuffer.toString('base64'),
        }],
      });

      await supabase.from('inscritos')
        .update({ certificado_enviado: true, certificado_enviado_em: new Date().toISOString() })
        .eq('id', ins.id);

      enviados++;
    } catch (e) {
      console.error(`Certificado erro inscrito ${ins.hash}:`, e.message);
      erros++;
    }
  }

  return res.status(200).json({
    success:  true,
    enviados,
    erros,
    mensagem: `Certificados enviados: ${enviados}. Erros: ${erros}.`,
  });
};
