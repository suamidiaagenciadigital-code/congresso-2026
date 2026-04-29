-- ============================================================
-- LIMPAR INSCRIÇÕES DE TESTE
-- Execute no Supabase > SQL Editor
-- ============================================================

-- Opção A: Apagar TODAS as inscrições e reiniciar o ID
TRUNCATE TABLE inscritos RESTART IDENTITY;

-- Opção B: Apagar apenas inscrições específicas por e-mail
-- DELETE FROM inscritos WHERE email IN ('seu@email.com', 'teste@teste.com');

-- Opção C: Apagar apenas as mais recentes (ex: últimas 10)
-- DELETE FROM inscritos WHERE id IN (
--   SELECT id FROM inscritos ORDER BY criado_em DESC LIMIT 10
-- );

-- Verificar resultado:
SELECT count(*) AS total_restante FROM inscritos;
