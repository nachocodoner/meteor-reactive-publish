import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MongoClient } from 'mongodb';
import { command, freePort, launch, stop, until } from './process.mjs';

export async function startMongo({ node, mongod, log }) {
  const binary = mongod || path.resolve(node, '../../mongodb/bin/mongod');
  const versionText = await command(binary, ['--version']);
  const version = versionText.match(/db version v([^\s]+)/)?.[1];
  if (!version) throw new Error('Could not determine Mongo version');
  const port = await freePort();
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'reactive-publish-bench-mongo-')
  );
  const handle = launch(
    binary,
    [
      '--dbpath',
      directory,
      '--port',
      String(port),
      '--bind_ip',
      '127.0.0.1',
      '--replSet',
      'bench',
      '--oplogSize',
      '64',
    ],
    { log }
  );
  const url = `mongodb://127.0.0.1:${port}`;
  let connection;
  try {
    await until(
      async () => {
        if (handle.child.exitCode !== null) throw new Error(handle.output());
        const client = new MongoClient(`${url}/?directConnection=true`, {
          serverSelectionTimeoutMS: 500,
        });
        try {
          await client.connect();
          await client.db('admin').command({ ping: 1 });
          connection = client;
          return true;
        } catch (error) {
          await client.close();
          throw error;
        }
      },
      { timeout: 30000, label: 'Mongo startup' }
    );
    await connection.db('admin').command({
      replSetInitiate: {
        _id: 'bench',
        members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      },
    });
    await until(
      async () =>
        (await connection.db('admin').command({ hello: 1 })).isWritablePrimary,
      { label: 'Mongo primary' }
    );
    return {
      connection,
      pid: handle.child.pid,
      version,
      binary,
      url: `${url}/bench?replicaSet=bench`,
      oplog: `${url}/local?replicaSet=bench`,
      async close() {
        await connection.close();
        await stop(handle);
        await fs.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await connection?.close();
    await stop(handle);
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
