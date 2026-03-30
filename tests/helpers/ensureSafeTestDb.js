const databaseUrl = process.env.DATABASE_URL || '';
const allowUnsafe = ['1', 'true', 'yes'].includes(String(process.env.ALLOW_NON_TEST_DATABASE_FOR_JEST || '').trim().toLowerCase());
const looksLikeTestDb = /(^|[_\-/.])test([_\-/.]|$)/i.test(databaseUrl);

if (!allowUnsafe && !looksLikeTestDb) {
  throw new Error(
    'Jest fue bloqueado para proteger tu base activa. Usa un DATABASE_URL de pruebas (por ejemplo con "test" en el nombre) o define ALLOW_NON_TEST_DATABASE_FOR_JEST=true si realmente querés correr la suite contra esta base.'
  );
}