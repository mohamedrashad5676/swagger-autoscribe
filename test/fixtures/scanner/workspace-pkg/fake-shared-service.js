// Simulates a workspace package like @onmeeting/shared: real files live
// HERE, outside node_modules, but the app requires it through a
// node_modules symlink (see ../node_modules/fake-shared-pkg) — exactly
// how npm workspaces / `file:../onmeeting-shared` installs it. The
// scanner must still walk into it (first-party code), unlike a genuine
// third-party dependency physically installed under node_modules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PaymentRequiredException } = require('@nestjs/common');

class FakeSharedGrpcClientFactory {
  async getClient() {
    throw new PaymentRequiredException('shared client factory blew up');
  }
}

module.exports = { FakeSharedGrpcClientFactory };
