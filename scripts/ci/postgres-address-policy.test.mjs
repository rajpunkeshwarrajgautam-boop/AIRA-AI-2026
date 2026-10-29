import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertConnectedServerAddressMatchesExpected,
  assertDnsAddressesMatchExpected,
  extractVerifiedPostgresAddresses,
  normalizeIpAddress,
} from './postgres-address-policy.mjs';

const DOCKER_NETWORK_ID = 'd'.repeat(64);
const POSTGRES_CONTAINER_ID = 'a'.repeat(64);
const RUNNER_CONTAINER_ID = 'b'.repeat(64);
const POSTGRES_ENDPOINT_ID = 'c'.repeat(64);
const RUNNER_ENDPOINT_ID = 'e'.repeat(64);

function dockerInspectionFixture() {
  const networkName = 'aira-ci-network';
  const postgresContainerName = 'aira-ci-postgres';
  const runnerContainerName = 'aira-ci-runner';
  return {
    networkName,
    postgresContainerName,
    runnerContainerName,
    networkInspection: [{
      Name: networkName,
      Id: DOCKER_NETWORK_ID,
      Internal: true,
      Containers: {
        [POSTGRES_CONTAINER_ID]: {
          Name: postgresContainerName,
          EndpointID: POSTGRES_ENDPOINT_ID,
          MacAddress: '02:42:ac:1d:00:02',
          IPv4Address: '172.29.0.2/16',
          IPv6Address: 'fd00::2/64',
        },
        [RUNNER_CONTAINER_ID]: {
          Name: runnerContainerName,
          EndpointID: RUNNER_ENDPOINT_ID,
          MacAddress: '02:42:ac:1d:00:03',
          IPv4Address: '172.29.0.3/16',
          IPv6Address: 'fd00::3/64',
        },
      },
    }],
    containerInspections: [
      {
        Id: POSTGRES_CONTAINER_ID,
        Name: `/${postgresContainerName}`,
        NetworkSettings: {
          Networks: {
            [networkName]: {
              NetworkID: DOCKER_NETWORK_ID,
              EndpointID: POSTGRES_ENDPOINT_ID,
              Aliases: [postgresContainerName, 'postgres'],
              IPAddress: '172.29.0.2',
              GlobalIPv6Address: 'fd00::2',
            },
          },
        },
      },
      {
        Id: RUNNER_CONTAINER_ID,
        Name: `/${runnerContainerName}`,
        NetworkSettings: {
          Networks: {
            [networkName]: {
              NetworkID: DOCKER_NETWORK_ID,
              EndpointID: RUNNER_ENDPOINT_ID,
              Aliases: [runnerContainerName],
              IPAddress: '172.29.0.3',
              GlobalIPv6Address: 'fd00::3',
            },
          },
        },
      },
    ],
  };
}

function extractFixture(fixture) {
  return extractVerifiedPostgresAddresses({
    networkInspection: fixture.networkInspection,
    containerInspections: fixture.containerInspections,
    networkName: fixture.networkName,
    postgresContainerName: fixture.postgresContainerName,
    runnerContainerName: fixture.runnerContainerName,
  });
}

test('extracts endpoint addresses from realistic container inspect attachments and binds them to network membership', () => {
  const fixture = dockerInspectionFixture();
  assert.equal(
    Object.hasOwn(fixture.networkInspection[0].Containers[POSTGRES_CONTAINER_ID], 'Aliases'),
    false,
  );
  assert.deepEqual(extractFixture(fixture), ['172.29.0.2', 'fd00::2']);
});

test('rejects non-internal or unexpected network membership and invalid Docker attachments', () => {
  const nonInternal = dockerInspectionFixture();
  nonInternal.networkInspection[0].Internal = false;
  assert.throws(() => extractFixture(nonInternal), /Docker-inspected PostgreSQL endpoint identity is invalid/);

  const unexpectedMember = dockerInspectionFixture();
  unexpectedMember.networkInspection[0].Containers['f'.repeat(64)] = {
    Name: 'unexpected-container',
    EndpointID: '1'.repeat(64),
  };
  assert.throws(() => extractFixture(unexpectedMember), /Docker-inspected PostgreSQL endpoint identity is invalid/);

  const missingAlias = dockerInspectionFixture();
  missingAlias.containerInspections[0].NetworkSettings.Networks[missingAlias.networkName].Aliases = [
    missingAlias.postgresContainerName,
  ];
  assert.throws(() => extractFixture(missingAlias), /Docker-inspected PostgreSQL endpoint identity is invalid/);

  const extraNetwork = dockerInspectionFixture();
  extraNetwork.containerInspections[0].NetworkSettings.Networks.unexpected = {};
  assert.throws(() => extractFixture(extraNetwork), /Docker-inspected PostgreSQL endpoint identity is invalid/);

  const missingEndpoint = dockerInspectionFixture();
  const pgAttachment = missingEndpoint.containerInspections[0].NetworkSettings.Networks[missingEndpoint.networkName];
  pgAttachment.IPAddress = '';
  pgAttachment.GlobalIPv6Address = '';
  assert.throws(() => extractFixture(missingEndpoint), /Docker-inspected PostgreSQL endpoint identity is invalid/);

  const malformedEndpoint = dockerInspectionFixture();
  malformedEndpoint.containerInspections[0].NetworkSettings.Networks[malformedEndpoint.networkName].IPAddress = '172.29.0.999';
  assert.throws(() => extractFixture(malformedEndpoint), /Docker-inspected PostgreSQL endpoint identity is invalid/);

  const identityMismatch = dockerInspectionFixture();
  identityMismatch.containerInspections[0].NetworkSettings.Networks[identityMismatch.networkName].EndpointID = 'f'.repeat(64);
  assert.throws(() => extractFixture(identityMismatch), /Docker-inspected PostgreSQL endpoint identity is invalid/);
});

test('accepts the Docker-inspected IPv4 endpoint resolved by postgres DNS', () => {
  assert.equal(
    assertDnsAddressesMatchExpected({
      expectedAddresses: ['172.29.0.2'],
      dnsAddresses: ['172.29.0.2'],
    }),
    true,
  );
  assert.equal(
    assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['172.29.0.2'],
      dnsAddresses: ['172.29.0.2'],
      serverAddress: '172.29.0.2',
    }),
    true,
  );
});

test('normalizes compressed and expanded IPv6 endpoint spellings', () => {
  assert.equal(normalizeIpAddress('2001:db8::2'), normalizeIpAddress('2001:0db8:0:0:0:0:0:2'));
  assert.equal(
    assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['2001:0db8:0:0:0:0:0:2'],
      dnsAddresses: ['2001:db8::2'],
      serverAddress: '2001:db8:0:0:0:0:0:2/128',
    }),
    true,
  );
});

test('normalizes IPv4-mapped IPv6 to the exact assigned IPv4 endpoint', () => {
  assert.equal(normalizeIpAddress('::ffff:172.29.0.2'), normalizeIpAddress('172.29.0.2'));
  assert.equal(
    assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['172.29.0.2'],
      dnsAddresses: ['::ffff:172.29.0.2'],
      serverAddress: '::ffff:ac1d:2',
    }),
    true,
  );
});

test('rejects a different private server address even when DNS resolves to the expected container', () => {
  assert.throws(
    () => assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['10.42.0.2'],
      dnsAddresses: ['10.42.0.2'],
      serverAddress: '10.42.0.9',
    }),
    /does not match its isolated container endpoint/,
  );
});

test('rejects DNS answers outside the Docker-inspected PostgreSQL endpoint set', () => {
  assert.throws(
    () => assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['10.42.0.2'],
      dnsAddresses: ['10.42.0.2', '10.42.0.9'],
      serverAddress: '10.42.0.2',
    }),
    /DNS resolved outside the isolated PostgreSQL container endpoints/,
  );
});

test('rejects a server address that is DNS-resolved but not assigned to the PostgreSQL container', () => {
  assert.throws(
    () => assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['10.42.0.2'],
      dnsAddresses: ['10.42.0.9'],
      serverAddress: '10.42.0.9',
    }),
    /DNS resolved outside the isolated PostgreSQL container endpoints/,
  );
});

test('rejects empty endpoint sets, loopback, and malformed IP addresses', () => {
  assert.throws(
    () => assertDnsAddressesMatchExpected({ expectedAddresses: [], dnsAddresses: ['10.42.0.2'] }),
    /expected PostgreSQL container endpoints must contain at least one address/,
  );
  assert.throws(
    () => assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['10.42.0.2'],
      dnsAddresses: ['10.42.0.2'],
      serverAddress: '127.0.0.1',
    }),
    /does not match its isolated container endpoint/,
  );
  assert.throws(() => normalizeIpAddress('not-an-ip'), /invalid IP address/);
});
