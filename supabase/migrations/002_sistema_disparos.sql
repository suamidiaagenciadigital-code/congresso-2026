-- ─────────────────────────────────────────────────────────────────
-- Sistema de Disparos — Fenapestalozzi 2026
-- Rodar no SQL Editor do Supabase
-- ─────────────────────────────────────────────────────────────────

-- 1. Campanhas
CREATE TABLE IF NOT EXISTS campanhas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text NOT NULL,
  tipo          text NOT NULL CHECK (tipo IN ('email','whatsapp')),
  publico       text NOT NULL CHECK (publico IN ('inscritos','externos')),
  assunto       text,                        -- só para e-mail
  conteudo_html text,                        -- só para e-mail
  conteudo_text text,                        -- WhatsApp ou fallback texto
  status        text NOT NULL DEFAULT 'rascunho'
                  CHECK (status IN ('rascunho','aguardando_aprovacao','aprovado','enviando','concluido','cancelado')),
  agendado_para timestamptz,
  aprovado_por  text,
  aprovado_em   timestamptz,
  iniciado_em   timestamptz,
  concluido_em  timestamptz,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- 2. Contatos externos (lista CSV importada para captação)
CREATE TABLE IF NOT EXISTS contatos_externos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text,
  email      text,
  telefone   text,
  origem     text,           -- nome do arquivo CSV ou campanha de origem
  ativo      boolean NOT NULL DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS contatos_externos_email_idx
  ON contatos_externos (lower(email)) WHERE email IS NOT NULL;

-- 3. Descadastros (LGPD — lista negra de e-mails externos)
CREATE TABLE IF NOT EXISTS descadastros (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  motivo       text,
  criado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS descadastros_email_idx
  ON descadastros (lower(email));

-- 4. Disparos (log individual por campanha × destinatário)
CREATE TABLE IF NOT EXISTS disparos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campanha_id    uuid NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
  destinatario   text NOT NULL,   -- e-mail ou telefone
  nome           text,
  status         text NOT NULL DEFAULT 'pendente'
                   CHECK (status IN ('pendente','enviado','entregue','aberto','clicado','falhou','descadastrado')),
  provider_id    text,            -- ID retornado pelo Resend ou Z-API
  erro           text,
  enviado_em     timestamptz,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS disparos_campanha_idx ON disparos (campanha_id);
CREATE INDEX IF NOT EXISTS disparos_status_idx   ON disparos (status);

-- 5. Trigger para atualizar atualizado_em automaticamente
CREATE OR REPLACE FUNCTION set_atualizado_em()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.atualizado_em = now(); RETURN NEW; END;
$$;

CREATE TRIGGER campanhas_atualizado_em
  BEFORE UPDATE ON campanhas
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

CREATE TRIGGER disparos_atualizado_em
  BEFORE UPDATE ON disparos
  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
