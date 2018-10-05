import * as assert from 'assert';
import { pluginName } from './common';
import {
  ApolloServerPluginBase,
  ApolloServerRequestListenerBase,
  PluginEventServerWillStart,
} from 'apollo-server-plugin-base';
import Agent from './agent';
import { GraphQLSchema } from 'graphql/type';
import { generateSchemaHash } from './schema';

class RequestListener extends ApolloServerRequestListenerBase {
  start() {
    console.log('Request started');
  }
}

export default class extends ApolloServerPluginBase {
  async serverWillStart({
    schema,
    engine,
    persistedQueries,
  }: PluginEventServerWillStart['args']): Promise<void> {
    assert.ok(schema instanceof GraphQLSchema);
    const schemaHash = await generateSchemaHash(schema);

    if (!engine || !engine.serviceId) {
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

    this.agent = new Agent({ schemaHash, engine, cache });
    await this.agent.start();
  }

  requestDidStart() {
    console.log('Here comes the request listener.');
    return new RequestListener();
  }
}
