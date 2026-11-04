// Contract shared by both tools. Keep the byte-identical copies in sync.
// SHA-256 hashes use UTF-8 with LF line endings for Windows/Linux parity.
export const MIGRATIONS = Object.freeze({
  '001': '5c5f8eed8ade4a6c6438bcf84f47d85d1da96a6cb5748f87638614c706331ccb',
  '002': 'ded1fdb5fee5bd1cae54d6f2cf63653a8f341df39a05c38918cce896e7a37f3e',
  '003': '1a1ae565e6122c3c9b901fbb4ae9e63fc95f79f12711cf5dbb506c887f0d52e7'
});

export async function validateRuntime (pool) {
  const client = await pool.connect();
  let clientFailure = null;
  const onError = (error) => { clientFailure = error; };
  client.on('error', onError);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query(`
      SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
        OR current_user<>session_user
        OR EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass
          AND d.refobjid=r.oid AND d.deptype='o' AND d.dbid IN (0,(SELECT oid FROM pg_database WHERE datname=current_database())))
        OR EXISTS (SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'MEMBER'))
        OR has_database_privilege(current_database(),'CREATE') OR has_database_privilege(current_database(),'TEMP')
        OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND (has_schema_privilege(n.oid,'CREATE') OR n.nspowner=r.oid))
        OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relowner=r.oid)
        OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
            AND has_schema_privilege(n.oid,'USAGE')
            AND NOT (n.nspname='public' AND c.relname IN
              ('studies','consumer_cursors','spec_cache','settings','settings_history','schema_migrations','settings_history_id_seq',
               'runtime_identity','event_inbox','event_rejections','event_outbox','outbox_attempts','manual_commands','delivery_gates',
               'event_rejections_rejection_id_seq','event_outbox_outbox_id_seq','outbox_attempts_id_seq'))
            AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN
              has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                OR has_any_column_privilege(c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
              WHEN c.relkind='S' THEN has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE') ELSE false END)
        OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
            AND (p.proowner=r.oid OR (p.prosecdef AND has_schema_privilege(n.oid,'USAGE') AND has_function_privilege(p.oid,'EXECUTE')))) AS unsafe
      FROM pg_roles r WHERE r.rolname=current_user
    `);
    if (rows[0]?.unsafe !== false) throw new Error('Runtime role has ownership, memberships or administrative/DDL privileges');
    // The function is SECURITY INVOKER, owned by the migrator, with a pinned path.
    await client.query('SELECT public.ajtool_validate_schema()');
    const versions = (await client.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version')).rows;
    if (versions.length!==3 || versions.some((r) => MIGRATIONS[r.version]!==r.checksum)) {
      throw new Error('Migration version/checksum mismatch');
    }
    const privileges = await client.query(`
      WITH expected(table_name,privileges) AS (VALUES
        ('studies',ARRAY['SELECT','INSERT','UPDATE']),
        ('consumer_cursors',ARRAY['SELECT','INSERT','UPDATE']),
        ('spec_cache',ARRAY['SELECT','INSERT','UPDATE']),
        ('settings',ARRAY['SELECT','INSERT','UPDATE']),
        ('settings_history',ARRAY['SELECT','INSERT']),
        ('schema_migrations',ARRAY['SELECT']),
        ('runtime_identity',ARRAY['SELECT','INSERT','UPDATE']),
        ('event_inbox',ARRAY['SELECT','INSERT','UPDATE']),
        ('event_rejections',ARRAY['SELECT','INSERT']),
        ('event_outbox',ARRAY['SELECT','INSERT','UPDATE']),
        ('outbox_attempts',ARRAY['SELECT','INSERT','UPDATE']),
        ('manual_commands',ARRAY['SELECT','INSERT','UPDATE']),
        ('delivery_gates',ARRAY['SELECT','INSERT','UPDATE'])
      )
      SELECT e.table_name,p.privilege FROM expected e
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(privilege)
      WHERE has_table_privilege('public.'||e.table_name,p.privilege) IS DISTINCT FROM (p.privilege=ANY(e.privileges))
        OR (p.privilege IN ('SELECT','INSERT','UPDATE','REFERENCES') AND NOT p.privilege=ANY(e.privileges)
          AND has_any_column_privilege('public.'||e.table_name,p.privilege))
      UNION ALL
      SELECT s.seq_name,p.privilege FROM (VALUES
        ('settings_history_id_seq'),
        ('event_rejections_rejection_id_seq'),
        ('event_outbox_outbox_id_seq'),
        ('outbox_attempts_id_seq')
      ) AS s(seq_name)
      CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) AS p(privilege)
      WHERE has_sequence_privilege('public.'||s.seq_name,p.privilege) IS DISTINCT FROM (p.privilege<>'UPDATE')
    `);
    if (privileges.rowCount) throw new Error('Runtime effective table/column/sequence privileges violate the least-privilege contract');
    await client.query('COMMIT');
  } catch (error) {
    clientFailure = error;
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release(clientFailure);
  }
}
