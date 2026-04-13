#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const rootDir = path.resolve(__dirname, '..');
const envTestPath = path.join(rootDir, '.env.test');

dotenv.config({ path: envTestPath });

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: false,
    ...options
  });

  return result;
}

function runInherited(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env
  });

  if (result.status !== 0) {
    fail(`Fallo ejecutando ${command} ${args.join(' ')}`);
  }
}

if (!fs.existsSync(envTestPath)) {
  fail('No existe .env.test en la raíz del proyecto.');
}

const databaseUrl = process.env.DATABASE_URL || '';
if (!databaseUrl) {
  fail('DATABASE_URL no está definido en .env.test.');
}

let parsedUrl;
try {
  parsedUrl = new URL(databaseUrl);
} catch (_error) {
  fail('DATABASE_URL de .env.test no es válido.');
}

const databaseName = parsedUrl.pathname.replace(/^\//, '').split('/')[0];
if (!databaseName) {
  fail('No se pudo determinar el nombre de la base de datos de pruebas.');
}

const dockerCheck = run('docker', ['ps', '--format', '{{.Names}}']);
const hasDockerContainer = dockerCheck.status === 0
  && dockerCheck.stdout.split(/\r?\n/).includes('trident_postgres');

const baseEnv = { ...process.env, DATABASE_URL: databaseUrl, DOTENV_CONFIG_PATH: envTestPath };
const sqlExists = `SELECT 1 FROM pg_database WHERE datname = '${databaseName}'`;
const sqlCreate = `CREATE DATABASE \"${databaseName}\"`;

function databaseExistsViaDocker() {
  const result = run('docker', [
    'exec',
    'trident_postgres',
    'psql',
    '-U',
    parsedUrl.username || 'trident',
    '-d',
    'postgres',
    '-tAc',
    sqlExists
  ]);
  return result.status === 0 && result.stdout.trim() === '1';
}

function createDatabaseViaDocker() {
  const result = run('docker', [
    'exec',
    'trident_postgres',
    'psql',
    '-U',
    parsedUrl.username || 'trident',
    '-d',
    'postgres',
    '-c',
    sqlCreate
  ]);

  if (result.status !== 0) {
    fail(result.stderr || 'No se pudo crear la base de pruebas con docker exec.');
  }
}

function databaseExistsViaPsql() {
  const result = run('psql', [databaseUrl.replace(`/${databaseName}?`, '/postgres?'), '-tAc', sqlExists]);
  return result.status === 0 && result.stdout.trim() === '1';
}

function createDatabaseViaPsql() {
  const adminUrl = databaseUrl.replace(`/${databaseName}?`, '/postgres?');
  const result = run('psql', [adminUrl, '-c', sqlCreate]);
  if (result.status !== 0) {
    fail(result.stderr || 'No se pudo crear la base de pruebas con psql.');
  }
}

console.log(`Preparando base de pruebas: ${databaseName}`);

if (hasDockerContainer) {
  if (!databaseExistsViaDocker()) {
    console.log('Creando base de pruebas en contenedor Docker...');
    createDatabaseViaDocker();
  } else {
    console.log('La base de pruebas ya existe en Docker.');
  }
} else {
  console.log('No se detectó el contenedor trident_postgres; intentando con psql local...');
  if (!databaseExistsViaPsql()) {
    console.log('Creando base de pruebas con psql...');
    createDatabaseViaPsql();
  } else {
    console.log('La base de pruebas ya existe en psql local.');
  }
}

console.log('Aplicando esquema Prisma a la base de pruebas...');
runInherited('npx', ['prisma', 'db', 'push', '--skip-generate'], baseEnv);

console.log('Sembrando datos base de pruebas...');
runInherited('node', ['scripts/reset.js'], baseEnv);

console.log('Base de pruebas lista.');
