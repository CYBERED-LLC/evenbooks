import { dropStaleTestDatabases } from '../src/testing';

export default async function setup(): Promise<void> {
  await dropStaleTestDatabases();
}
