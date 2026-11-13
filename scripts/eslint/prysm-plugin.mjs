// Local ESLint rules that back up the database boundary (ADR-0003, ADR-0007). The type system is the primary
// barrier (@prysm/db exports no pool and no raw client); these rules catch what a type error can't, such as a
// new dependency on a database driver. `packages/db` is exempt in eslint.config.mjs.

/** Modules that hand out a raw connection or build their own pool, bypassing `withTenant`. */
const RAW_DRIVER_MODULES = new Set([
  'pg',
  'pg-pool',
  'pg-native',
  'postgres',
  '@neondatabase/serverless',
  'drizzle-orm/node-postgres',
  'drizzle-orm/postgres-js',
  'drizzle-orm/pg-proxy',
]);

/** Names that used to be exported by @prysm/db and must never come back. */
const RAW_POOL_NAMES = new Set(['createPool', 'Pool', 'PoolClient', 'Client']);

/** Method names that run SQL or open a connection. */
const DB_METHODS = new Set(['query', 'execute', 'connect', 'transaction', 'begin']);

/** Receiver names that suggest a database handle. A heuristic: the types are the real guard. */
const DB_LIKE = /^(pool|db|database|client|conn|connection|pg|sql|knex)$/i;

const WITH_TENANT_MESSAGE =
  'Run database queries inside `db.withTenant(tenantId, (tx) => ...)` and use `tx` (ADR-0007). Do not query a pool, client or db handle directly.';

/** Rule: no raw database pool or driver outside packages/db. */
const noRawPool = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow importing database drivers or the raw pool outside packages/db (ADR-0003).' },
    schema: [],
    messages: {
      driver:
        '"{{name}}" is a raw database driver. Use `createDb` from @prysm/db and go through `withTenant` (ADR-0003).',
      pool: '"{{name}}" is a raw pool/client and is not part of @prysm/db\'s API. Use `Db` and `withTenant` (ADR-0003).',
    },
  },
  create(context) {
    const checkSource = (node, source) => {
      if (typeof source !== 'string') return;
      if (RAW_DRIVER_MODULES.has(source)) context.report({ node, messageId: 'driver', data: { name: source } });
    };
    return {
      ImportDeclaration(node) {
        checkSource(node, node.source.value);
        if (node.source.value === '@prysm/db' || String(node.source.value).startsWith('@prysm/db/')) {
          for (const spec of node.specifiers) {
            const imported = spec.type === 'ImportSpecifier' ? (spec.imported.name ?? spec.imported.value) : undefined;
            if (imported && RAW_POOL_NAMES.has(imported))
              context.report({ node: spec, messageId: 'pool', data: { name: imported } });
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSource(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') checkSource(node, node.source.value);
      },
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments[0]?.type === 'Literal'
        )
          checkSource(node, node.arguments[0].value);
      },
    };
  },
};

const isFunction = (node) => node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';

/** The name a call's receiver is known by: `db` in `db.query()`, and `db` in `this.db.query()`. */
function receiverName(object) {
  if (object.type === 'Identifier') return object.name;
  if (object.type === 'MemberExpression' && !object.computed && object.property.type === 'Identifier')
    return object.property.name;
  return undefined;
}

/** Rule: queries only through the `tx` handed out by `withTenant`. */
const dbAccessInWithTenant = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow running queries on a db-like handle outside a withTenant callback (ADR-0007).' },
    schema: [],
    messages: { outside: WITH_TENANT_MESSAGE },
  },
  create(context) {
    /** Function node -> names of its parameters, for callbacks passed to withTenant or withGlobal. */
    const tenantCallbacks = new Map();
    /** Parameter-name sets of the withTenant / withGlobal (ADR-0013) callbacks we are currently inside. */
    const active = [];
    const enter = (node) => {
      const params = tenantCallbacks.get(node);
      if (params) active.push(params);
    };
    const exit = (node) => {
      if (tenantCallbacks.has(node)) active.pop();
    };
    return {
      CallExpression(node) {
        const callee = node.callee;
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
              ? callee.property.name
              : undefined;
        if (name === 'withTenant' || name === 'withGlobal') {
          const callback = node.arguments.findLast(isFunction);
          if (callback) {
            tenantCallbacks.set(
              callback,
              new Set(callback.params.filter((p) => p.type === 'Identifier').map((p) => p.name)),
            );
          }
          return;
        }
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
        if (!DB_METHODS.has(callee.property.name)) return;
        const receiver = receiverName(callee.object);
        if (!receiver || !DB_LIKE.test(receiver)) return;
        if (active.some((params) => params.has(receiver))) return;
        context.report({ node, messageId: 'outside' });
      },
      ArrowFunctionExpression: enter,
      FunctionExpression: enter,
      'ArrowFunctionExpression:exit': exit,
      'FunctionExpression:exit': exit,
    };
  },
};

export default { rules: { 'no-raw-pool': noRawPool, 'db-access-in-with-tenant': dbAccessInWithTenant } };
