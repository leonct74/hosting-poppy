import { describe, expect, it } from "vitest";
import type { Route53Client } from "@aws-sdk/client-route-53";

import {
  changeStatus,
  classifyName,
  decodeDnsName,
  findZone,
  inspectName,
  mapChangeStatus,
  pickZone,
  readRecords,
  resolveName,
  removeRecordIfOurs,
  upsertRecord,
  wildcardCandidates,
  type DnsResolver,
  type RecordSetLike,
  type ZoneRecords,
} from "./dns";
import type { HttpError } from "./errors";
import type { ExistingRecord } from "./types";

// A hand-written stand-in for the Route 53 client, same shape as amplify.test.ts's: it
// dispatches on the command's class name and records every call, so a test can assert both
// what we asked AWS for and — for the write guard, which is the point of that guard — what we
// deliberately did NOT ask for.

type Handler = (input: Record<string, unknown>) => unknown;

class FakeRoute53 {
  readonly calls: { name: string; input: Record<string, unknown> }[] = [];

  constructor(private readonly handlers: Record<string, Handler | Handler[]>) {}

  async send(command: { input: Record<string, unknown> }): Promise<unknown> {
    const name = command.constructor.name.replace(/Command$/, "");
    this.calls.push({ name, input: command.input });
    const handler = this.handlers[name];
    if (!handler) throw new Error(`the test did not expect a ${name} call`);
    if (Array.isArray(handler)) {
      const nth = this.calls.filter((c) => c.name === name).length - 1;
      const step = handler[Math.min(nth, handler.length - 1)];
      if (!step) throw new Error(`the test ran out of ${name} answers`);
      return step(command.input);
    }
    return handler(command.input);
  }

  names(): string[] {
    return this.calls.map((c) => c.name);
  }

  inputs(name: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.name === name).map((c) => c.input);
  }

  input(name: string): Record<string, unknown> {
    const first = this.inputs(name)[0];
    if (!first) throw new Error(`no ${name} call was made`);
    return first;
  }
}

function clientOf(handlers: Record<string, Handler | Handler[]>): { r53: Route53Client; fake: FakeRoute53 } {
  const fake = new FakeRoute53(handlers);
  return { r53: fake as unknown as Route53Client, fake };
}

function zone(name: string, id = "/hostedzone/Z1", privateZone = false): Record<string, unknown> {
  return { Id: id, Name: name, Config: { PrivateZone: privateZone } };
}

function rrset(name: string, type: string, values: string[]): RecordSetLike {
  return { Name: name, Type: type, ResourceRecords: values.map((Value) => ({ Value })) };
}

function record(name: string, type: string, values: string[]): ExistingRecord {
  return { name, type, values };
}

/** The zone as it was on the day this feature was written: a catch-all pointing at Firebase. */
const FIREBASE = "example-app.web.app";
const AMPLIFY = "d1abc2def3.cloudfront.net";

describe("decodeDnsName", () => {
  it("turns Route 53's escaped wildcard back into the record the user recognises", () => {
    // The bug this whole file exists for hides here: compared raw, `\052.example.net.` matches
    // no wildcard we look for, and the name reads as a corrupted record if it is ever shown.
    expect(decodeDnsName("\\052.example.net.")).toBe("*.example.net");
  });

  it("drops the trailing dot and the case AWS returns", () => {
    expect(decodeDnsName("WWW.Example.NET.")).toBe("www.example.net");
  });

  it("leaves an escape it cannot read alone rather than inventing a character", () => {
    expect(decodeDnsName("a\\9zz.example.net.")).toBe("a\\9zz.example.net");
  });

  it("has an answer for nothing at all", () => {
    expect(decodeDnsName(undefined)).toBe("");
    expect(decodeDnsName("   ")).toBe("");
  });
});

describe("pickZone", () => {
  it("finds the zone for the exact domain", () => {
    expect(pickZone([zone("example.net.")], "example.net")).toEqual({ id: "Z1", name: "example.net" });
  });

  it("finds the zone a subdomain belongs to", () => {
    expect(pickZone([zone("example.net.")], "hp-test.example.net")).toEqual({ id: "Z1", name: "example.net" });
  });

  it("prefers the deepest zone, because a delegated subzone is where the record must go", () => {
    const zones = [zone("example.net.", "/hostedzone/ZPARENT"), zone("dev.example.net.", "/hostedzone/ZCHILD")];
    expect(pickZone(zones, "app.dev.example.net")).toEqual({ id: "ZCHILD", name: "dev.example.net" });
  });

  it("does NOT let example.com claim notexample.com", () => {
    expect(pickZone([zone("example.com.")], "notexample.com")).toBeNull();
  });

  it("ignores a private zone, which answers inside a VPC and nowhere the public can see", () => {
    const zones = [zone("example.net.", "/hostedzone/ZPRIVATE", true)];
    expect(pickZone(zones, "hp-test.example.net")).toBeNull();
  });

  it("falls back to the public parent when the deeper zone is private", () => {
    const zones = [
      zone("example.net.", "/hostedzone/ZPUBLIC"),
      zone("dev.example.net.", "/hostedzone/ZPRIVATE", true),
    ];
    expect(pickZone(zones, "app.dev.example.net")).toEqual({ id: "ZPUBLIC", name: "example.net" });
  });

  it("returns null when the account holds no zone for the domain", () => {
    expect(pickZone([zone("somewhere-else.com.")], "example.net")).toBeNull();
  });
});

describe("findZone", () => {
  it("starts the listing at the registered domain, not at the address typed", async () => {
    const { r53, fake } = clientOf({
      ListHostedZonesByName: () => ({ HostedZones: [zone("example.net.")], IsTruncated: false }),
    });
    await expect(findZone(r53, "hp-test.example.net")).resolves.toEqual({ id: "Z1", name: "example.net" });
    // Starting at the full address would skip the parent zone, which is the usual answer.
    expect(fake.input("ListHostedZonesByName").DNSName).toBe("example.net");
  });

  it("follows the pages while they are still inside the domain", async () => {
    const { r53, fake } = clientOf({
      ListHostedZonesByName: [
        () => ({
          HostedZones: [zone("example.net.", "/hostedzone/ZPARENT")],
          IsTruncated: true,
          NextDNSName: "dev.example.net",
          NextHostedZoneId: "ZCHILD",
        }),
        () => ({ HostedZones: [zone("dev.example.net.", "/hostedzone/ZCHILD")], IsTruncated: false }),
      ],
    });
    await expect(findZone(r53, "app.dev.example.net")).resolves.toEqual({ id: "ZCHILD", name: "dev.example.net" });
    const [, second] = fake.inputs("ListHostedZonesByName");
    expect(second).toMatchObject({ DNSName: "dev.example.net", HostedZoneId: "ZCHILD" });
  });

  it("stops paging once the listing has left the domain, however many zones follow", async () => {
    const { r53, fake } = clientOf({
      ListHostedZonesByName: [
        () => ({
          HostedZones: [zone("example.net."), zone("zzz-unrelated.com.", "/hostedzone/ZOTHER")],
          IsTruncated: true,
          NextDNSName: "zzzz-more.com",
          NextHostedZoneId: "ZMORE",
        }),
      ],
    });
    await expect(findZone(r53, "hp-test.example.net")).resolves.toEqual({ id: "Z1", name: "example.net" });
    expect(fake.names()).toEqual(["ListHostedZonesByName"]);
  });

  it("says null when the domain is not managed in this account", async () => {
    const { r53 } = clientOf({
      ListHostedZonesByName: () => ({ HostedZones: [zone("someone-else.com.")], IsTruncated: false }),
    });
    await expect(findZone(r53, "example.net")).resolves.toBeNull();
  });

  it("asks AWS nothing when there is no domain to ask about", async () => {
    const { r53, fake } = clientOf({});
    await expect(findZone(r53, "   ")).resolves.toBeNull();
    expect(fake.names()).toEqual([]);
  });
});

describe("wildcardCandidates", () => {
  it("names the catch-all that would answer for a subdomain", () => {
    expect(wildcardCandidates("hp-test.example.net", "example.net")).toEqual(["*.example.net"]);
  });

  it("works upwards from the closest, because the closest is the one DNS uses", () => {
    expect(wildcardCandidates("a.b.example.net", "example.net")).toEqual(["*.b.example.net", "*.example.net"]);
  });

  it("has none for the domain itself — a wildcard never answers for the name above it", () => {
    expect(wildcardCandidates("example.net", "example.net")).toEqual([]);
  });

  it("never looks above the zone we are allowed to read", () => {
    expect(wildcardCandidates("example.net.evil.test", "example.net")).toEqual([]);
  });

  it("knows only the immediate parent when the zone is unknown", () => {
    expect(wildcardCandidates("a.b.example.net")).toEqual(["*.b.example.net"]);
  });
});

describe("readRecords", () => {
  it("collects every record at the exact name and stops at the next one", async () => {
    const { r53 } = clientOf({
      ListResourceRecordSets: () => ({
        ResourceRecordSets: [
          rrset("www.example.net.", "A", ["203.0.113.10"]),
          rrset("www.example.net.", "TXT", ['"hello"']),
          rrset("zzz.example.net.", "A", ["203.0.113.99"]),
        ],
      }),
    });
    const found = await readRecords(r53, "Z1", "www.example.net", "example.net");
    expect(found.exact).toEqual([
      record("www.example.net", "A", ["203.0.113.10"]),
      record("www.example.net", "TXT", ['"hello"']),
    ]);
  });

  it("reads an ALIAS, which has no records of its own, from its target", async () => {
    const { r53 } = clientOf({
      ListResourceRecordSets: () => ({
        ResourceRecordSets: [{ Name: "example.net.", Type: "A", AliasTarget: { DNSName: `${AMPLIFY}.` } }],
      }),
    });
    const found = await readRecords(r53, "Z1", "example.net", "example.net");
    expect(found.exact).toEqual([record("example.net", "A", [`${AMPLIFY}.`])]);
  });

  it("finds the catch-all that shadows a free name — the live failure, in one test", async () => {
    const { r53, fake } = clientOf({
      ListResourceRecordSets: [
        () => ({ ResourceRecordSets: [rrset("www.example.net.", "A", ["203.0.113.10"])] }), // nothing at the name
        () => ({
          ResourceRecordSets: [
            rrset("example.net.", "NS", ["ns-1.awsdns-01.org."]),
            rrset("\\052.example.net.", "CNAME", [FIREBASE]),
            rrset("www.example.net.", "A", ["203.0.113.10"]),
          ],
        }),
      ],
    });
    const found = await readRecords(r53, "Z1", "hp-test.example.net", "example.net");
    expect(found.exact).toEqual([]);
    expect(found.wildcard).toEqual(record("*.example.net", "CNAME", [FIREBASE]));
    // The second read starts at the parent, where the wildcard sorts just after its records.
    expect(fake.inputs("ListResourceRecordSets")[1]?.StartRecordName).toBe("example.net");
  });

  it("does not look for a wildcard once the name itself has records — a specific record wins", async () => {
    const { r53, fake } = clientOf({
      ListResourceRecordSets: () => ({ ResourceRecordSets: [rrset("hp-test.example.net.", "CNAME", [FIREBASE])] }),
    });
    await readRecords(r53, "Z1", "hp-test.example.net", "example.net");
    expect(fake.names()).toEqual(["ListResourceRecordSets"]);
  });

  it("does not look for a wildcard above the domain itself", async () => {
    const { r53, fake } = clientOf({
      ListResourceRecordSets: () => ({ ResourceRecordSets: [rrset("zzz.example.net.", "A", ["203.0.113.9"])] }),
    });
    const found = await readRecords(r53, "Z1", "example.net", "example.net");
    expect(found).toEqual({ exact: [] });
    expect(fake.names()).toEqual(["ListResourceRecordSets"]);
  });

  it("climbs to the next catch-all when the closest parent has none", async () => {
    const { r53, fake } = clientOf({
      ListResourceRecordSets: [
        () => ({ ResourceRecordSets: [rrset("zzz.example.net.", "A", ["203.0.113.9"])] }), // nothing at the name
        () => ({ ResourceRecordSets: [rrset("b.example.net.", "A", ["203.0.113.8"])] }), // no *.b.example.net
        () => ({ ResourceRecordSets: [rrset("\\052.example.net.", "CNAME", [FIREBASE])] }),
      ],
    });
    const found = await readRecords(r53, "Z1", "a.b.example.net", "example.net");
    expect(found.wildcard).toEqual(record("*.example.net", "CNAME", [FIREBASE]));
    expect(fake.inputs("ListResourceRecordSets").map((i) => i.StartRecordName)).toEqual([
      "a.b.example.net",
      "b.example.net",
      "example.net",
    ]);
  });

  it("stops scanning once the page leaves the parent it was reading", async () => {
    const { r53 } = clientOf({
      ListResourceRecordSets: [
        () => ({ ResourceRecordSets: [rrset("zzz.example.net.", "A", ["203.0.113.9"])] }),
        () => ({
          ResourceRecordSets: [
            rrset("b.example.net.", "A", ["203.0.113.8"]),
            rrset("c.example.net.", "A", ["203.0.113.7"]), // outside b's subtree: the scan ends here
            rrset("\\052.b.example.net.", "CNAME", [FIREBASE]),
          ],
        }),
        () => ({ ResourceRecordSets: [] }),
      ],
    });
    const found = await readRecords(r53, "Z1", "a.b.example.net", "example.net");
    expect(found.wildcard).toBeUndefined();
  });

  it("asks AWS nothing without a name or a zone", async () => {
    const { r53, fake } = clientOf({});
    await expect(readRecords(r53, "Z1", "")).resolves.toEqual({ exact: [] });
    await expect(readRecords(r53, "", "www.example.net")).resolves.toEqual({ exact: [] });
    expect(fake.names()).toEqual([]);
  });
});

describe("classifyName", () => {
  const free: ZoneRecords = { exact: [] };

  it("calls a name nothing claims free", () => {
    expect(classifyName({ name: "hp-test.example.net", zone: "example.net", target: AMPLIFY, records: free })).toEqual({
      state: "free",
    });
  });

  it("calls a name a catch-all answers for shadowed, and says what the catch-all is", () => {
    const records: ZoneRecords = { exact: [], wildcard: record("*.example.net", "CNAME", [FIREBASE]) };
    expect(classifyName({ name: "hp-test.example.net", zone: "example.net", target: AMPLIFY, records })).toEqual({
      state: "shadowed-by-wildcard",
      existing: record("*.example.net", "CNAME", [FIREBASE]),
    });
  });

  it("stays shadowed even when the catch-all points at us — the certificate record still needs its own name", () => {
    const records: ZoneRecords = { exact: [], wildcard: record("*.example.net", "CNAME", [AMPLIFY]) };
    expect(
      classifyName({ name: "hp-test.example.net", zone: "example.net", target: AMPLIFY, records }).state,
    ).toBe("shadowed-by-wildcard");
  });

  it("calls a name pointing somewhere else taken, and says where", () => {
    const records: ZoneRecords = { exact: [record("www.example.net", "CNAME", [FIREBASE])] };
    expect(classifyName({ name: "www.example.net", zone: "example.net", target: AMPLIFY, records })).toEqual({
      state: "taken",
      existing: record("www.example.net", "CNAME", [FIREBASE]),
    });
  });

  it("recognises our own record through a trailing dot and a capital letter", () => {
    const records: ZoneRecords = { exact: [record("www.example.net", "CNAME", [`${AMPLIFY.toUpperCase()}.`])] };
    expect(classifyName({ name: "WWW.example.net.", zone: "example.net", target: AMPLIFY, records }).state).toBe(
      "already-ours",
    );
  });

  it("recognises an ALIAS pointing at us, which carries its target and no records", () => {
    const records: ZoneRecords = { exact: [record("example.net", "A", [`${AMPLIFY}.`])] };
    expect(classifyName({ name: "example.net", zone: "example.net", target: AMPLIFY, records }).state).toBe(
      "already-ours",
    );
  });

  it("lets a record at the name beat the catch-all, because that is what DNS does", () => {
    const records: ZoneRecords = {
      exact: [record("www.example.net", "CNAME", [FIREBASE])],
      wildcard: record("*.example.net", "CNAME", [AMPLIFY]),
    };
    expect(classifyName({ name: "www.example.net", zone: "example.net", target: AMPLIFY, records }).state).toBe("taken");
  });

  it("does not read a zone's own SOA and nameservers as somebody's website", () => {
    // Every hosted zone has these. Calling the root domain "taken" because of them would
    // scare a user off their own domain with a sentence about AWS's nameservers.
    const records: ZoneRecords = {
      exact: [
        record("example.net", "SOA", ["ns-1.awsdns-01.org. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400"]),
        record("example.net", "NS", ["ns-1.awsdns-01.org."]),
      ],
    };
    expect(classifyName({ name: "example.net", zone: "example.net", target: AMPLIFY, records }).state).toBe("free");
  });

  it("does not read mail and verification records at the root as a website either", () => {
    const records: ZoneRecords = {
      exact: [
        record("example.net", "MX", ["10 mail.example.net."]),
        record("example.net", "TXT", ['"v=spf1 include:amazonses.com ~all"']),
      ],
    };
    expect(classifyName({ name: "example.net", zone: "example.net", target: AMPLIFY, records }).state).toBe("free");
  });

  it("DOES read a live address at the root as taken", () => {
    const records: ZoneRecords = {
      exact: [record("example.net", "NS", ["ns-1.awsdns-01.org."]), record("example.net", "A", ["203.0.113.10"])],
    };
    expect(classifyName({ name: "example.net", zone: "example.net", target: AMPLIFY, records })).toEqual({
      state: "taken",
      existing: record("example.net", "A", ["203.0.113.10"]),
    });
  });

  it("treats a lone TXT below the root as taken, because a CNAME cannot sit beside one", () => {
    const records: ZoneRecords = { exact: [record("www.example.net", "TXT", ['"verify=abc"'])] };
    expect(classifyName({ name: "www.example.net", zone: "example.net", target: AMPLIFY, records }).state).toBe("taken");
  });

  it("treats a delegated subdomain as taken — a record we wrote there would never be read", () => {
    const records: ZoneRecords = { exact: [record("dev.example.net", "NS", ["ns1.othercloud.example."])] };
    expect(classifyName({ name: "dev.example.net", zone: "example.net", target: AMPLIFY, records }).state).toBe("taken");
  });

  it("never claims a record is ours when there is nothing yet to compare it against", () => {
    const records: ZoneRecords = { exact: [record("www.example.net", "CNAME", [AMPLIFY])] };
    expect(classifyName({ name: "www.example.net", zone: "example.net", records }).state).toBe("taken");
  });

  it("shows the record that looks like the site when a name holds several", () => {
    const records: ZoneRecords = {
      exact: [record("www.example.net", "TXT", ['"verify=abc"']), record("www.example.net", "CNAME", [FIREBASE])],
    };
    expect(classifyName({ name: "www.example.net", zone: "example.net", target: AMPLIFY, records }).existing).toEqual(
      record("www.example.net", "CNAME", [FIREBASE]),
    );
  });
});

describe("upsertRecord", () => {
  const freePage = { ResourceRecordSets: [] };

  it("writes the record and hands back the change to follow", async () => {
    const { r53, fake } = clientOf({
      ListResourceRecordSets: () => freePage,
      ChangeResourceRecordSets: () => ({ ChangeInfo: { Id: "/change/C123", Status: "PENDING" } }),
    });
    const changeId = await upsertRecord(r53, "Z1", "hp-test.example.net", AMPLIFY, { zoneName: "example.net" });
    expect(changeId).toBe("C123");

    const batch = fake.input("ChangeResourceRecordSets");
    expect(batch).toMatchObject({ HostedZoneId: "Z1" });
    expect(batch.ChangeBatch).toMatchObject({
      Changes: [
        {
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: "hp-test.example.net",
            Type: "CNAME",
            TTL: 300,
            ResourceRecords: [{ Value: AMPLIFY }],
          },
        },
      ],
    });
    // Route 53 records carry no tags, so the comment is the only trace we can leave in AWS.
    expect(String((batch.ChangeBatch as { Comment: string }).Comment)).toContain("HostingPoppy");
  });

  it("REFUSES to move a name that points somewhere else, and writes nothing at all", async () => {
    const { r53, fake } = clientOf({
      ListResourceRecordSets: () => ({ ResourceRecordSets: [rrset("www.example.net.", "CNAME", [FIREBASE])] }),
    });
    const failure = await upsertRecord(r53, "Z1", "www.example.net", AMPLIFY, { zoneName: "example.net" }).catch(
      (e: HttpError) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as HttpError).status).toBe(409);
    expect((failure as HttpError).message).toContain(FIREBASE);
    expect(fake.names()).toEqual(["ListResourceRecordSets"]);
  });

  it("moves it once the user has said yes to exactly that", async () => {
    const { r53, fake } = clientOf({
      ListResourceRecordSets: () => ({ ResourceRecordSets: [rrset("www.example.net.", "CNAME", [FIREBASE])] }),
      ChangeResourceRecordSets: () => ({ ChangeInfo: { Id: "C456" } }),
    });
    await expect(
      upsertRecord(r53, "Z1", "www.example.net", AMPLIFY, { zoneName: "example.net", replaceExisting: true }),
    ).resolves.toBe("C456");
    expect(fake.names()).toContain("ChangeResourceRecordSets");
  });

  it("writes again happily when the record is already ours — running it twice is not a change", async () => {
    const { r53 } = clientOf({
      ListResourceRecordSets: () => ({ ResourceRecordSets: [rrset("www.example.net.", "CNAME", [`${AMPLIFY}.`])] }),
      ChangeResourceRecordSets: () => ({ ChangeInfo: { Id: "C789" } }),
    });
    await expect(upsertRecord(r53, "Z1", "www.example.net", AMPLIFY, { zoneName: "example.net" })).resolves.toBe("C789");
  });

  it("is not shadowed into refusing by a catch-all — that name is still free to take", async () => {
    const { r53 } = clientOf({
      ListResourceRecordSets: [
        () => freePage,
        () => ({ ResourceRecordSets: [rrset("\\052.example.net.", "CNAME", [FIREBASE])] }),
      ],
      ChangeResourceRecordSets: () => ({ ChangeInfo: { Id: "C321" } }),
    });
    await expect(upsertRecord(r53, "Z1", "hp-test.example.net", AMPLIFY, { zoneName: "example.net" })).resolves.toBe(
      "C321",
    );
  });

  it("refuses a record type it cannot write, before it touches anything", async () => {
    const { r53, fake } = clientOf({});
    const failure = await upsertRecord(r53, "Z1", "example.net", AMPLIFY, {
      type: "ANAME",
      zoneName: "example.net",
    }).catch((e: HttpError) => e);
    expect((failure as HttpError).status).toBe(400);
    expect((failure as HttpError).message).toContain("www.example.net");
    expect(fake.names()).toEqual([]);
  });

  it("refuses a domain on its own, which DNS will not let us point this way", async () => {
    const { r53, fake } = clientOf({});
    const failure = await upsertRecord(r53, "Z1", "example.net", AMPLIFY, { zoneName: "example.net" }).catch(
      (e: HttpError) => e,
    );
    expect((failure as HttpError).status).toBe(400);
    expect((failure as HttpError).message).toContain("www.example.net");
    expect(fake.names()).toEqual([]);
  });

  it("refuses without a target rather than pointing a live address at nothing", async () => {
    const { r53, fake } = clientOf({});
    const failure = await upsertRecord(r53, "Z1", "www.example.net", "  ").catch((e: HttpError) => e);
    expect((failure as HttpError).status).toBe(400);
    expect(fake.names()).toEqual([]);
  });
});

describe("mapChangeStatus", () => {
  it("reads AWS's two words, and is honest about anything else", () => {
    expect(mapChangeStatus("INSYNC")).toBe("published");
    expect(mapChangeStatus("PENDING")).toBe("pending");
    expect(mapChangeStatus(undefined)).toBe("unknown");
    expect(mapChangeStatus("SOMETHING_NEW")).toBe("unknown");
  });
});

describe("changeStatus", () => {
  it("asks about the change by the id AWS gave us", async () => {
    const { r53, fake } = clientOf({ GetChange: () => ({ ChangeInfo: { Status: "INSYNC" } }) });
    await expect(changeStatus(r53, "/change/C123")).resolves.toBe("published");
    expect(fake.input("GetChange").Id).toBe("C123");
  });

  it("degrades to unknown when the read is refused, because the real proof is DNS", async () => {
    const { r53 } = clientOf({
      GetChange: () => {
        throw Object.assign(new Error("not authorized to perform route53:GetChange"), {
          name: "AccessDeniedException",
        });
      },
    });
    await expect(changeStatus(r53, "C123")).resolves.toBe("unknown");
  });

  it("asks nothing without a change to ask about", async () => {
    const { r53, fake } = clientOf({});
    await expect(changeStatus(r53, "")).resolves.toBe("unknown");
    expect(fake.names()).toEqual([]);
  });
});

describe("resolveName", () => {
  function resolver(over: Partial<DnsResolver> = {}): DnsResolver {
    return {
      resolveCname: async () => [],
      resolve4: async () => [],
      ...over,
    };
  }

  it("says what the name is pointed at, tidied and without duplicates", async () => {
    const answers = await resolveName("hp-test.example.net", {
      resolver: resolver({ resolveCname: async () => [`${FIREBASE}.`, FIREBASE.toUpperCase()] }),
    });
    expect(answers).toEqual([FIREBASE]);
  });

  it("falls back to the addresses when there is no name to show", async () => {
    const answers = await resolveName("example.net", {
      resolver: resolver({
        resolveCname: async () => {
          throw new Error("ENODATA");
        },
        resolve4: async () => ["203.0.113.10"],
      }),
    });
    expect(answers).toEqual(["203.0.113.10"]);
  });

  it("never throws — nothing answering is itself the answer", async () => {
    const answers = await resolveName("gone.example.net", {
      resolver: resolver({
        resolveCname: async () => {
          throw Object.assign(new Error("queryCname ENOTFOUND"), { code: "ENOTFOUND" });
        },
        resolve4: async () => {
          throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
        },
      }),
    });
    expect(answers).toEqual([]);
  });

  it("gives up on a resolver that never answers, instead of hanging the screen", async () => {
    const answers = await resolveName("slow.example.net", {
      timeoutMs: 5,
      resolver: resolver({ resolveCname: () => new Promise<string[]>(() => {}), resolve4: () => new Promise<string[]>(() => {}) }),
    });
    expect(answers).toEqual([]);
  });

  it("looks nothing up without a name", async () => {
    let asked = false;
    const answers = await resolveName("  ", {
      resolver: resolver({
        resolveCname: async () => {
          asked = true;
          return [];
        },
      }),
    });
    expect(answers).toEqual([]);
    expect(asked).toBe(false);
  });
});

describe("inspectName", () => {
  const answers = (values: string[]): DnsResolver => ({
    resolveCname: async () => values,
    resolve4: async () => [],
  });

  it("tells the whole story of the address that failed live", async () => {
    const { r53 } = clientOf({
      ListHostedZonesByName: () => ({ HostedZones: [zone("example.net.")], IsTruncated: false }),
      ListResourceRecordSets: [
        () => ({ ResourceRecordSets: [rrset("www.example.net.", "A", ["203.0.113.10"])] }),
        () => ({ ResourceRecordSets: [rrset("\\052.example.net.", "CNAME", [FIREBASE])] }),
      ],
    });
    const facts = await inspectName(r53, "HP-Test.example.net", { target: AMPLIFY, resolver: answers([FIREBASE]) });
    expect(facts).toEqual({
      address: "hp-test.example.net",
      root: "example.net",
      prefix: "hp-test",
      zone: { id: "Z1", name: "example.net" },
      state: "shadowed-by-wildcard",
      existing: record("*.example.net", "CNAME", [FIREBASE]),
      answers: [FIREBASE],
    });
  });

  it("says unknown — not broken — when the domain lives at another DNS host", async () => {
    const { r53 } = clientOf({
      ListHostedZonesByName: () => ({ HostedZones: [], IsTruncated: false }),
    });
    const facts = await inspectName(r53, "www.elsewhere.test", { resolver: answers(["some-other-host.example"]) });
    expect(facts.state).toBe("unknown");
    expect(facts.zone).toBeUndefined();
    // The lookup still happened: what the internet says is useful even when AWS knows nothing.
    expect(facts.answers).toEqual(["some-other-host.example"]);
  });

  it("degrades to unknown when the zone read is refused, keeping AWS's words for the details", async () => {
    const { r53 } = clientOf({
      ListHostedZonesByName: () => {
        throw Object.assign(new Error("User is not authorized to perform route53:ListHostedZonesByName"), {
          name: "AccessDeniedException",
        });
      },
    });
    const facts = await inspectName(r53, "hp-test.example.net", { resolver: answers([]) });
    expect(facts.state).toBe("unknown");
    expect(facts.detail).toContain("AccessDeniedException");
    expect(facts.answers).toEqual([]);
  });

  it("degrades the same way when the records cannot be read, and still names the zone", async () => {
    const { r53 } = clientOf({
      ListHostedZonesByName: () => ({ HostedZones: [zone("example.net.")], IsTruncated: false }),
      ListResourceRecordSets: () => {
        throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      },
    });
    const facts = await inspectName(r53, "hp-test.example.net", { resolver: answers([]) });
    expect(facts.state).toBe("unknown");
    expect(facts.zone).toEqual({ id: "Z1", name: "example.net" });
    expect(facts.detail).toContain("Rate exceeded");
  });

  it("recognises an address that is already pointed at this website", async () => {
    const { r53 } = clientOf({
      ListHostedZonesByName: () => ({ HostedZones: [zone("example.net.")], IsTruncated: false }),
      ListResourceRecordSets: () => ({ ResourceRecordSets: [rrset("hp-test.example.net.", "CNAME", [`${AMPLIFY}.`])] }),
    });
    const facts = await inspectName(r53, "hp-test.example.net", { target: AMPLIFY, resolver: answers([AMPLIFY]) });
    expect(facts.state).toBe("already-ours");
  });
});

describe("removeRecordIfOurs — teardown must not leave a dangling name", () => {
  const RECORD = {
    Name: "hp-test.example.net.",
    Type: "CNAME",
    TTL: 300,
    ResourceRecords: [{ Value: "dxuryuunhw10h.cloudfront.net" }],
  };
  const clientWith = (record: unknown, onSend?: (cmd: unknown) => void) =>
    ({
      send: async (cmd: { constructor: { name: string }; input: unknown }) => {
        onSend?.(cmd);
        if (cmd.constructor.name === "ListResourceRecordSetsCommand") {
          return { ResourceRecordSets: record ? [record] : [] };
        }
        return {};
      },
    }) as never;

  it("deletes a record that still points where we put it", async () => {
    const sent: unknown[] = [];
    const ok = await removeRecordIfOurs(
      clientWith(RECORD, (c) => sent.push(c)),
      "Z1",
      "hp-test.example.net",
      "dxuryuunhw10h.cloudfront.net",
    );
    expect(ok).toBe(true);
    const del = sent.find((c) => (c as { constructor: { name: string } }).constructor.name === "ChangeResourceRecordSetsCommand");
    expect(del).toBeTruthy();
    // Route 53 requires the record set EXACTLY as it exists, so we must send back what we read.
    expect((del as { input: { ChangeBatch: { Changes: { Action: string; ResourceRecordSet: unknown }[] } } }).input.ChangeBatch.Changes[0]).toMatchObject({
      Action: "DELETE",
      ResourceRecordSet: RECORD,
    });
  });

  it("LEAVES a record the user has repointed at something of their own", async () => {
    // The dangerous case: teardown must never delete a name that is no longer ours, or we
    // take down whatever they moved it to.
    const theirs = { ...RECORD, ResourceRecords: [{ Value: "their-new-app.example.net" }] };
    const sent: unknown[] = [];
    const ok = await removeRecordIfOurs(clientWith(theirs, (c) => sent.push(c)), "Z1", "hp-test.example.net", "dxuryuunhw10h.cloudfront.net");
    expect(ok).toBe(false);
    expect(sent.some((c) => (c as { constructor: { name: string } }).constructor.name === "ChangeResourceRecordSetsCommand")).toBe(false);
  });

  it("treats an already-absent record as nothing to do", async () => {
    expect(await removeRecordIfOurs(clientWith(null), "Z1", "hp-test.example.net", "x.cloudfront.net")).toBe(false);
  });

  it("never throws when the zone cannot be read — teardown must not fail on DNS", async () => {
    const broken = { send: async () => { throw new Error("AccessDenied"); } } as never;
    await expect(removeRecordIfOurs(broken, "Z1", "hp-test.example.net", "x.cloudfront.net")).resolves.toBe(false);
  });
});
