import { getOperationManifestUrl } from './common';
import { createHash } from 'crypto';
import fetch, { Response, RequestInit } from 'node-fetch';
import { KeyValueCache } from 'apollo-server-caching';

const DEFAULT_POLL_SECONDS: number = 2;
const SYNC_WARN_TIME_SECONDS: number = 60;

interface AgentOptions {
  debug?: boolean;
  pollSeconds?: number;
  schemaHash: string;
  engine: any;
  cache: KeyValueCache;
}

interface Operation {
  signature: string;
  document: string;
}

interface OperationManifest {
  version: number;
  operations: Array<Operation>;
}

type SignatureStore = Set<string>;

const cacheKey = (signature: string) => `apq:${signature}`;

export default class Agent {
  private timer?: NodeJS.Timer;
  private hashedServiceId?: string;
  private requestInFlight: boolean = false;
  private lastSuccessfulCheck?: Date;
  private lastSuccessfulETag?: string;
  private lastOperationSignatures: SignatureStore = new Set();

  constructor(private options: AgentOptions) {}

  private getHashedServiceId(): string {
    return (this.hashedServiceId =
      this.hashedServiceId ||
      createHash('sha512')
        .update(this.options.engine.serviceId)
        .digest('hex'));
  }

  private pollSeconds() {
    return this.options.pollSeconds || DEFAULT_POLL_SECONDS;
  }

  async start() {
    // Make sure the timer is running.
    await this.checkForUpdate();

    this.timer =
      this.timer ||
      setInterval(async () => {
        await this.checkForUpdate();
      }, this.pollSeconds() * 1000);
  }

  private timeSinceLastSuccessfulCheck() {
    if (!this.lastSuccessfulCheck) {
      // So far back that it's never?
      return -Infinity;
    }
    return new Date().getTime() - this.lastSuccessfulCheck.getTime();
  }

  private warnWhenLossOfSync() {
    // This is probably good information to reveal in general, though nice
    // to have in development.
    if (this.timeSinceLastSuccessfulCheck() > SYNC_WARN_TIME_SECONDS * 1000) {
      console.warn(
        `WARNING: More than ${SYNC_WARN_TIME_SECONDS} seconds has elapsed since a successful fetch of the manifest. (Last success: ${
          this.lastSuccessfulCheck
        })`,
      );
    }
  }

  private maybeLog(...args: any[]) {
    if (this.options.debug) {
      console.debug(...args);
    }
  }

  private async tryUpdate(): Promise<boolean> {
    this.maybeLog('Checking for manifest changes...');
    const manifestUrl = getOperationManifestUrl(
      this.getHashedServiceId(),
      this.options.schemaHash,
    );

    const fetchOptions: RequestInit = {
      // GET is what we request, but keep in mind that, when we include and get
      // a match on the `If-None-Match` header we'll get an early return with a
      // status code 304.
      method: 'GET',

      // More than three times our polling interval be long enough to wait.
      timeout: this.pollSeconds() * 3 /* times */ * 1000 /* ms */,
      headers: Object.create(null),
    };

    // By saving and providing our last known ETag, we can allow the storage
    // provider to return us a `304 Not Modified` header rather than the full
    // response.
    if (this.lastSuccessfulETag) {
      fetchOptions.headers = { 'If-None-Match': this.lastSuccessfulETag };
    }

    let response: Response;
    try {
      response = await fetch(manifestUrl, fetchOptions);
    } catch (err) {
      throw new Error(
        `Unable to fetch operation manifest for ${
          this.options.schemaHash
        } in '${this.options.engine.serviceId}'`,
      );
    }

    // When the response indicates that the resource hasn't changed, there's
    // no need to do any other work.  Returning true indicates that this is
    // a successful fetch and that we can be assured the manifest is current.
    if (response.status === 304) {
      this.maybeLog(
        'The published manifest was the same as the previous attempt.',
      );
      return false;
    }

    if (!response.ok) {
      throw new Error(`Could not fetch manifest ${await response.text()}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType !== 'application/json') {
      throw new Error(`Unexpected 'Content-Type' header: ${contentType}`);
    }

    this.updateManifest(await response.json());

    // Save the ETag of the manifest we just received so we can avoid fetching
    // the same manifest again.
    const receivedETag = response.headers.get('etag');
    if (receivedETag) {
      this.lastSuccessfulETag = JSON.parse(receivedETag);
    }

    // True is good!
    return true;
  }

  public async checkForUpdate() {
    // Display a warning message if things have fallen abnormally behind.
    this.warnWhenLossOfSync();

    // Don't check again if we're already in-flight.
    if (this.requestInFlight) {
      return;
    }

    try {
      // Prevent other requests from crossing paths.
      this.requestInFlight = true;

      // If tryUpdate returns true, we can consider this a success.
      if (this.tryUpdate()) {
        // Mark this for reporting and monitoring reasons.
        this.lastSuccessfulCheck = new Date();
      }
    } catch (err) {
      // Log the error, but re-throw it so it can bubble up to whoever would
      // like to handle it if anyone else has called us (we're public!)
      console.error(err);
      throw err;
    } finally {
      // Always wrap mark ourselves as finished, even in the event of an error.
      this.requestInFlight = false;
    }
  }

  public async updateManifest(manifest: OperationManifest) {
    if (
      !manifest ||
      manifest.version !== 1 ||
      !Array.isArray(manifest.operations)
    ) {
      throw new Error('Invalid manifest format.');
    }

    const incomingOperations: Map<string, string> = new Map();
    const replacementSignatures: SignatureStore = new Set();

    for (const operation of manifest.operations) {
      incomingOperations.set(operation.signature, operation.document);
    }

    // Loop through each operation in the current manifest.
    incomingOperations.forEach((document, signature) => {
      // Keep track of each operation in this manifest so we can store it
      // for comparison after the next fetch.
      replacementSignatures.add(signature);

      // If it it's _not_ in the last fetch, we know it's added.  We could
      // just set it — which would be less costly, but it's nice to have this
      // for debugging.
      if (!this.lastOperationSignatures.has(signature)) {
        // Newly added operation.
        this.maybeLog(`Incoming manifest ADDs: ${signature}`);
        this.options.cache.set(cacheKey(signature), document);
      }
    });

    // Explicitly purge items which have been removed since our last
    // successful fetch of the manifest.
    this.lastOperationSignatures.forEach(signature => {
      if (!incomingOperations.has(signature)) {
        // Remove operations which are no longer present.
        this.maybeLog(`Incoming manifest REMOVEs: ${signature}`);
        this.options.cache.delete(cacheKey(signature));
      }
    });

    // Save the ones from this fetch, so we know what to remove on the next
    // actual update.  Particularly important since some cache backings might
    // not actually let us look this up again.
    this.lastOperationSignatures = replacementSignatures;
  }

  check() {
    console.log();
  }
}
