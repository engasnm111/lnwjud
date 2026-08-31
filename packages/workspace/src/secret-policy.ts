import { err, ok, type Result } from '@lnwjud/domain';

const PRIVATE_KEY_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk'];

export class SecretPolicy {
  public assertReadable(relativePath: string): Result<void> {
    const normalizedPath = relativePath.replaceAll('/', '\\').replace(/^\.\\/, '');
    const segments = normalizedPath.split('\\').filter((segment) => segment.length > 0);
    const basename = segments.at(-1)?.toLowerCase() ?? '';
    const lowerPath = segments.map((segment) => segment.toLowerCase());
    const isEnvironmentSecret = basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example');
    const isPrivateKey = PRIVATE_KEY_PREFIXES.some((prefix) => basename.startsWith(prefix));
    const isDenied = isEnvironmentSecret
      || basename.endsWith('.pem')
      || basename.endsWith('.key')
      || basename.endsWith('.p12')
      || basename.endsWith('.pfx')
      || basename.endsWith('.kdbx')
      || isPrivateKey
      || lowerPath.includes('.ssh')
      || lowerPath.includes('.aws')
      || lowerPath.includes('.gnupg')
      || basename === 'credentials.json';

    if (isDenied) {
      return err({ code: 'SECRET_ACCESS_DENIED', message: 'Secret file access is denied', recoverable: false });
    }
    return ok(undefined);
  }
}
