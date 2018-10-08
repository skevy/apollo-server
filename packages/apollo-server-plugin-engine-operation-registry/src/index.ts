import * as assert from 'assert';
import { pluginName } from './common';
import {
  ApolloServerPlugin,
  GraphQLServiceContext,
  GraphQLRequestListener,
} from 'apollo-server-plugin-base';
import Agent from './agent';
import { GraphQLSchema } from 'graphql/type';
import { generateSchemaHash } from './schema';

export default class extends ApolloServerPlugin {
  private agent?: Agent;

  async serverWillStart({
    schema,
    engine,
    persistedQueries,
  }: GraphQLServiceContext): Promise<void> {
    assert.ok(schema instanceof GraphQLSchema);
    const schemaHash = await generateSchemaHash(schema);

    if (!engine || !engine.serviceID) {
      throw new Error(
        `${pluginName}: The Engine API key must be set to use the operation registry.`,
      );
    }

    if (!persistedQueries || !persistedQueries.cache) {
      throw new Error(
        `${pluginName}: Persisted queries must be enabled to use the operation registry.`,
      );
    }

    // We use which ever cache store is in place for persisted queries, be that
    // the default in-memory store, or other stateful store resource.
    const cache = persistedQueries.cache;

    this.agent = new Agent({ schemaHash, engine, cache, debug: true });
    await this.agent.start();
  }

  requestDidStart(): GraphQLRequestListener<any> {
    console.log('Here comes the request listener.');
    return {
      async prepareRequest({ request }) {
        console.log(request);
      },
    };
  }
}
