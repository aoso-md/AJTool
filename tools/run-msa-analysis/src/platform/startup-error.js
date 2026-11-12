// Fixed diagnostics only: never log connection strings, passwords or SQL text.
export class StartupDatabaseError extends Error {
  constructor (error, configured) {
    const cause = error?.cause || error;
    const message = cause?.message || '';
    const reason = !configured ? 'database_url_missing'
      : cause?.code === '28P01' || cause?.code === '28000' ? 'database_authentication_failed'
      : cause?.code === '3D000' ? 'database_not_found'
      : /ownership, memberships|administrative\/DDL/.test(message) ? 'database_role_unsafe'
      : cause?.code === '42501' || /privileges violate/.test(message) ? 'database_privileges_invalid'
      : /[Mm]igration|migration checksum|migration version/.test(message) ? 'database_migration_invalid'
      : /schema_contract/.test(message) || ['42P01', '42883', '42703'].includes(cause?.code) ? 'database_schema_incompatible'
      : 'database_unavailable';
    super(`STARTUP_CONFIGURATION_FAILURE [${reason}]: required PostgreSQL validation failed; HTTP and poller were not started.`);
    this.code = 'startup_configuration_failure';
    this.reason = reason;
  }
}
