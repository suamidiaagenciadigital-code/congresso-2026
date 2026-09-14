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

// Busca configurações do certificado no banco
async function getConfig() {
  try {
    const { data } = await supabase
      .from('configuracoes')
      .select('chave, valor')
      .in('chave', ['cert_arte_url', 'cert_nome_y', 'cert_nome_tamanho', 'cert_nome_cor']);
    const cfg = {};
    (data || []).forEach(r => { cfg[r.chave] = r.valor; });
    return cfg;
  } catch { return {}; }
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return rgb(r, g, b);
}

async function gerarCertificadoPDF(nome, eventoData, config) {
  const pdfDoc = await PDFDocument.create();

  // A4 paisagem em pontos: 297mm × 210mm
  const largura = 841.89;
  const altura  = 595.28;
  const page    = pdfDoc.addPage([largura, altura]);

  // Arte de fundo — lê do banco primeiro, depois env var como fallback
  const arteUrl = config.cert_arte_url || process.env.CERT_ARTE_URL;
  if (arteUrl) {
    try {
      const imgResp = await fetch(arteUrl);
      if (imgResp.ok) {
        const imgBytes = await imgResp.arrayBuffer();
        const isJpeg   = arteUrl.toLowerCase().match(/\.(jpg|jpeg)/);
        const img = isJpeg
          ? await pdfDoc.embedJpg(imgBytes)
          : await pdfDoc.embedPng(imgBytes);
        page.drawImage(img, { x: 0, y: 0, width: largura, height: altura });
      }
    } catch (e) {
      console.error('Arte do certificado não carregada:', e.message);
    }
  }

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Configurações do nome — banco > env > padrão
  const nomeY       = parseFloat(config.cert_nome_y      || process.env.CERT_NOME_Y      || '310');
  const tamNome     = parseFloat(config.cert_nome_tamanho || process.env.CERT_NOME_TAM   || '40');
  const corHex      = (config.cert_nome_cor || process.env.CERT_NOME_COR || '#1a1a1a').trim();
  const corNome     = corHex.startsWith('#') ? hexToRgb(corHex) : rgb(0.1, 0.1, 0.1);

  // Nome centralizado horizontalmente
  const nomeW = fontBold.widthOfTextAtSize(nome, tamNome);
  page.drawText(nome, {
    x:    (largura - nomeW) / 2,
    y:    nomeY,
    size: tamNome,
    font: fontBold,
    color: corNome,
  });

  // Data do evento
  if (eventoData) {
    const dataY = parseFloat(config.cert_nome_y || process.env.CERT_NOME_Y || '310') - 50;
    const tamData = 18;
    const dataW   = font.widthOfTextAtSize(eventoData, tamData);
    page.drawText(eventoData, {
      x:    (largura - dataW) / 2,
      y:    dataY,
      size: tamData,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ success: false, mensagem: 'Método não permitido.' });
  if (!autenticar(req))      return res.status(401).json({ success: false, mensagem: 'Não autorizado.' });

  const { modo, id } = req.body || {};
  if (!['todos', 'individual'].includes(modo))
    return res.status(400).json({ success: false, mensagem: 'Modo inválido.' });

  let query = supabase.from('inscritos').select('*');
  if (modo === 'todos')      query = query.eq('certificado_enviado', false);
  else if (modo === 'individual') query = query.eq('id', parseInt(id));

  const { data: inscritos, error } = await query;
  if (error) return res.status(500).json({ success: false, mensagem: 'Erro ao consultar banco.' });
  if (!inscritos?.length) return res.status(200).json({ success: true, enviados: 0, mensagem: 'Nenhum inscrito pendente.' });

  const eventoNome = process.env.EVENTO_NOME || 'Congresso Fenapestalozzi 2026';
  const eventoData = process.env.EVENTO_DATA || '10 a 13 de novembro de 2026';

  // Carrega configurações uma vez para todos os envios
  const config = await getConfig();

  if (!config.cert_arte_url && !process.env.CERT_ARTE_URL) {
    return res.status(400).json({
      success: false,
      mensagem: 'Nenhuma arte de certificado configurada. Faça o upload da arte no painel.',
    });
  }

  let enviados = 0, erros = 0;

  for (const ins of inscritos) {
    const nome = ins.nome_social || ins.nome_completo;
    try {
      const pdfBuffer = await gerarCertificadoPDF(nome, eventoData, config);

      await resend.emails.send({
        from: process.env.RESEND_FROM || `${eventoNome} <onboarding@resend.dev>`,
        to:   ins.email,
        subject: `Seu certificado — ${eventoNome}`,
        html: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:0">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f9;padding:24px 0">
<tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
    <tr>
      <td style="background:#402B16;border-radius:8px 8px 0 0;padding:24px 28px;text-align:center">
        <p style="margin:0 0 4px;color:rgba(255,255,255,.7);font-size:11px;letter-spacing:2px;text-transform:uppercase">Fenapestalozzi</p>
        <h1 style="margin:0;color:#ffffff;font-size:18px;line-height:1.4">${eventoNome}</h1>
        <p style="margin:6px 0 0;color:rgba(255,255,255,.8);font-size:13px">Certificado de Participação</p>
      </td>
    </tr>
    <tr>
      <td style="background:#ffffff;padding:28px 32px">
        <p style="font-size:15px;color:#1a1a1a">Prezado(a) <strong>${nome}</strong>,</p>
        <p style="font-size:14px;color:#2d2d2d;line-height:1.6;margin:12px 0">
          Segue em anexo o seu <strong>certificado de participação</strong> no <strong>${eventoNome}</strong>,
          realizado em <strong>${eventoData}</strong>, em Brasília, DF.
        </p>
        <p style="font-size:14px;color:#2d2d2d;line-height:1.6">
          Agradecemos sua presença e contribuição ao evento!
        </p>
      </td>
    </tr>
    <tr>
      <td style="background:#f2f5f9;border-radius:0 0 8px 8px;padding:16px 28px;text-align:center;border-top:1px solid #dde3ed">
        <p style="margin:0;font-size:11px;color:#999;line-height:1.6">
          <strong>${eventoNome}</strong><br>
          Fenapestalozzi — Federação Nacional das Associações Pestalozzi<br>
          Este é um e-mail automático. Não responda a esta mensagem.
        </p>
      </td>
    </tr>
  </table>
</td></tr>
</table>
</div>`,
        attachments: [{
          filename: `certificado-${eventoNome.replace(/\s+/g, '-').toLowerCase()}.pdf`,
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
    success: true,
    enviados,
    erros,
    mensagem: `Certificados enviados: ${enviados}. Erros: ${erros}.`,
  });
};
