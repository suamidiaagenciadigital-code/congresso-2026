-- Execute no Supabase: painel do projeto > SQL Editor > New query
-- Cole este conteúdo e clique em Run

CREATE TABLE IF NOT EXISTS inscritos (
  id            SERIAL PRIMARY KEY,
  hash          VARCHAR(32)  NOT NULL UNIQUE,
  nome_completo VARCHAR(200) NOT NULL,
  nome_social   VARCHAR(200),
  cpf           VARCHAR(14)  NOT NULL UNIQUE,
  data_nascimento DATE,
  email         VARCHAR(200) NOT NULL,
  telefone      VARCHAR(20)  NOT NULL,
  vinculo_pestalozzi BOOLEAN NOT NULL DEFAULT FALSE,
  uf            CHAR(2),
  municipio     VARCHAR(100),
  area_atuacao       JSONB DEFAULT '[]',
  identidade_genero  JSONB DEFAULT '[]',
  genero_outro  VARCHAR(100),
  formacao      VARCHAR(50),
  como_soube         JSONB DEFAULT '[]',
  como_soube_outro   VARCHAR(100),
  pcd           BOOLEAN NOT NULL DEFAULT FALSE,
  pcd_descricao VARCHAR(300),
  pcd_recurso   VARCHAR(300),
  restricao_alimentar JSONB DEFAULT '[]',
  restricao_outro     VARCHAR(100),
  aceite_lgpd   BOOLEAN NOT NULL DEFAULT FALSE,
  aceite_imagem BOOLEAN DEFAULT FALSE,
  qrcode_url    TEXT,
  certificado_enviado    BOOLEAN DEFAULT FALSE,
  certificado_enviado_em TIMESTAMPTZ,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para busca rápida no painel admin
CREATE INDEX IF NOT EXISTS idx_inscritos_cpf   ON inscritos (cpf);
CREATE INDEX IF NOT EXISTS idx_inscritos_email ON inscritos (email);
CREATE INDEX IF NOT EXISTS idx_inscritos_hash  ON inscritos (hash);
CREATE INDEX IF NOT EXISTS idx_inscritos_uf    ON inscritos (uf);
