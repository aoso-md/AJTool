// Public PostgreSQL requires a trusted TLS chain. URL flags cannot weaken it.
export function databaseTransport(connectionString) {
  const url = new URL(connectionString);
  const host = url.hostname.toLowerCase();
  const privateHost = ['localhost','127.0.0.1','[::1]','postgres','db'].includes(host)
    || host.endsWith('.railway.internal');
  // Private networks may explicitly request verified TLS; URL flags never weaken public TLS.
  const verifiedTlsRequested=[...url.searchParams.entries()].some(([name,value])=>name.toLowerCase()==='sslmode'&&['require','verify-ca','verify-full'].includes(value.toLowerCase()));
  for (const name of [...url.searchParams.keys()]) {
    if (name.toLowerCase().startsWith('ssl')) url.searchParams.delete(name);
  }
  return {connectionString:url.toString(),ssl:privateHost&&!verifiedTlsRequested ? false : {rejectUnauthorized:true}};
}
