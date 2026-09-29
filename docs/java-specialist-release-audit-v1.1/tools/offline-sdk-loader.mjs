// Transport construction is forbidden in function-only tests. No MCP test is claimed.
export async function resolve(specifier, context, nextResolve) {
  if (process.env.AUDIT_STUB_SDK === '1' && /^@modelcontextprotocol\/sdk\/client\/(index|stdio)\.js$/.test(specifier)) {
    const name = specifier.includes('stdio') ? 'StdioClientTransport' : 'Client';
    return {url:'data:text/javascript,'+encodeURIComponent(`export class ${name} { constructor() { throw new Error('OFFLINE_AUDIT_TRANSPORT_FORBIDDEN'); } }`),shortCircuit:true};
  }
  return nextResolve(specifier,context);
}
