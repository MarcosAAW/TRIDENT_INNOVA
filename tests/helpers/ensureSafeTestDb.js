const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve(__dirname, '..', '..', '.env.test'),
  override: true
});

const databaseUrl = process.env.DATABASE_URL || '';
const allowUnsafe = ['1', 'true', 'yes'].includes(String(process.env.ALLOW_NON_TEST_DATABASE_FOR_JEST || '').trim().toLowerCase());

let looksLikeTestDb = /(^|[_\-/.])test([_\-/.?]|$)/i.test(databaseUrl);

if (!looksLikeTestDb && databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    looksLikeTestDb = /(^|[_\-/.])test([_\-/.]|$)/i.test(parsed.pathname);
  } catch (_error) {
    // Si la URL no se puede parsear, mantenemos la evaluación anterior.
  }
}

if (!allowUnsafe && !looksLikeTestDb) {
  throw new Error(
    'Jest fue bloqueado para proteger tu base activa. Usa un DATABASE_URL de pruebas (por ejemplo con "test" en el nombre) o define ALLOW_NON_TEST_DATABASE_FOR_JEST=true si realmente querés correr la suite contra esta base.'
  );
}