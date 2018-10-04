import { getOperationManifestUrl } from './common';
import { createHash } from 'crypto';

interface AgentOptions {
  schemaHash: string;
  engine: any;
}

export default class Agent {
  private timer?: NodeJS.Timer;
  private hashedServiceId?: string;
  private requestInFlight: boolean = false;
  private lastSuccessfulCheck?: Date;

  constructor(private options: AgentOptions) {}

  private getHashedServiceId(): string {
    return (this.hashedServiceId =
      this.hashedServiceId ||
      createHash('sha512')
        .update(this.options.engine.serviceId)
        .digest('hex'));
  }

  async start() {
    // Make sure the timer is running.
    await this.checkForUpdate();

    this.timer =
      this.timer ||
      setInterval(async () => {
        await this.checkForUpdate();
      }, 2000);
  }

  private timeSinceLastSuccessfulCheck() {
    if (!this.lastSuccessfulCheck) {
      return +Infinity;
    }
    return new Date().getTime() - this.lastSuccessfulCheck.getTime();
  }

  async checkForUpdate() {
    console.log('Checking for update');
    console.log('Time since last check', this.timeSinceLastSuccessfulCheck());
    // Don't check again if we're already in-flight.
    if (this.requestInFlight) {
      return;
    }
    this.requestInFlight = true;
    console.log(
      getOperationManifestUrl(
        this.getHashedServiceId(),
        this.options.schemaHash,
      ),
    );
    this.lastSuccessfulCheck = new Date();
    this.requestInFlight = false;
  }

  check() {
    console.log();
  }
}
