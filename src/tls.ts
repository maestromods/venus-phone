// HTTPS for the LAN. On first run this makes a private certificate authority (CA) for this PC with
// Windows' own certificate tools, then a server certificate signed by it for this PC's addresses.
// You install the CA certificate on your phone once; after that the connection is encrypted and
// your phone can tell it is really talking to this PC.
//
// Everything lives in app-data/tls. The CA's private key never leaves this PC, and the .pfx files
// are protected by a random password kept with Windows DPAPI (your user account only).

import { execFile } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { isIP } from "node:net";
import path from "node:path";
import { APP_DATA_DIR, decryptSecret, encryptSecret } from "./config.js";
import { isLocalAddress } from "./security.js";

const TLS_DIR = path.join(APP_DATA_DIR, "tls");
const CA_PFX = path.join(TLS_DIR, "ca.pfx");
const CA_CER = path.join(TLS_DIR, "venus-phone-ca.cer");
const LEAF_PFX = path.join(TLS_DIR, "server.pfx");
const LEAF_META = path.join(TLS_DIR, "server.json");
const SECRET = path.join(TLS_DIR, "secret.enc");
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

export interface TlsMaterial {
  pfx: Buffer;
  passphrase: string;
  /** The CA certificate (DER) your phone installs. */
  caCer: Buffer;
  /** SHA-256 fingerprint of the CA, to compare on the phone. */
  fingerprint: string;
}

function run(script: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      // Values reach the script only as environment variables, never as code.
      {
        windowsHide: true,
        // A launcher running in PowerShell 7 can pass its incompatible modules to Windows
        // PowerShell 5.1. Certificate cmdlets must use Windows' own Security/PKI modules.
        env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"), ...env },
        maxBuffer: 1024 * 1024,
      },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()),
    );
  });
}

const PREAMBLE = "$ErrorActionPreference='Stop'; $pw = ConvertTo-SecureString $env:VP_PASS -AsPlainText -Force;";

const MAKE_CA =
  PREAMBLE +
  "$ca = New-SelfSignedCertificate -Type Custom -Subject 'CN=Venus Phone Local CA' -FriendlyName 'Venus Phone Local CA' " +
  "-KeyUsage CertSign,CRLSign,DigitalSignature -KeyUsageProperty Sign -KeyExportPolicy Exportable " +
  "-KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(10) " +
  "-CertStoreLocation 'Cert:\\CurrentUser\\My' -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0');" +
  "try { Export-PfxCertificate -Cert $ca -FilePath $env:VP_CA_PFX -Password $pw | Out-Null; " +
  "Export-Certificate -Cert $ca -FilePath $env:VP_CA_CER -Type CERT | Out-Null } " +
  "finally { Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $ca.Thumbprint) -DeleteKey }";

const MAKE_LEAF =
  PREAMBLE +
  "$ca = Import-PfxCertificate -FilePath $env:VP_CA_PFX -CertStoreLocation 'Cert:\\CurrentUser\\My' -Password $pw -Exportable;" +
  "try { $leaf = New-SelfSignedCertificate -Type Custom -Subject 'CN=Venus Phone' -Signer $ca " +
  "-KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 " +
  "-NotAfter (Get-Date).AddDays(397) -KeyUsage DigitalSignature,KeyEncipherment " +
  "-CertStoreLocation 'Cert:\\CurrentUser\\My' " +
  "-TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1', ('2.5.29.17={text}' + $env:VP_SAN), '2.5.29.19={text}ca=0');" +
  "try { Export-PfxCertificate -Cert $leaf -FilePath $env:VP_LEAF_PFX -Password $pw -ChainOption EndEntityCertOnly | Out-Null } " +
  "finally { Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $leaf.Thumbprint) -DeleteKey } } " +
  "finally { Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $ca.Thumbprint) -DeleteKey }";

/** This PC's names and LAN addresses, the ones a phone could use to reach it. */
export function localNames(): { ips: string[]; names: string[] } {
  const ips = new Set<string>(["127.0.0.1"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && isLocalAddress(ni.address)) ips.add(ni.address);
    }
  }
  const host = hostname().replace(/[^A-Za-z0-9-]/g, "").slice(0, 63);
  const names = ["localhost", ...(host ? [host.toLowerCase(), `${host.toLowerCase()}.local`] : [])];
  return { ips: [...ips].sort(), names };
}

function sanFor({ ips, names }: { ips: string[]; names: string[] }): string {
  return [...ips.filter((ip) => isIP(ip) === 4).map((ip) => `IPAddress=${ip}`), ...names.map((n) => `DNS=${n}`)].join("&");
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function secret(): Promise<string> {
  if (await exists(SECRET)) return decryptSecret((await fs.readFile(SECRET, "utf8")).trim());
  const fresh = randomBytes(24).toString("hex");
  await fs.writeFile(SECRET, await encryptSecret(fresh), "utf8");
  return fresh;
}

/**
 * The certificate to serve. Makes the CA once, and a fresh server certificate whenever this PC's
 * addresses change or the current one is close to expiring.
 */
export async function ensureTls(): Promise<TlsMaterial> {
  if (process.platform !== "win32") throw new Error("Automatic HTTPS setup needs Windows.");
  await fs.mkdir(TLS_DIR, { recursive: true });
  const passphrase = await secret();
  const paths = { VP_PASS: passphrase, VP_CA_PFX: CA_PFX, VP_CA_CER: CA_CER, VP_LEAF_PFX: LEAF_PFX };

  if (!(await exists(CA_PFX)) || !(await exists(CA_CER))) {
    await fs.rm(LEAF_PFX, { force: true });
    await run(MAKE_CA, paths);
  }

  const san = sanFor(localNames());
  let meta: { san?: string; notAfter?: number } = {};
  try {
    meta = JSON.parse(await fs.readFile(LEAF_META, "utf8"));
  } catch {
    // No server certificate yet.
  }
  const stale = !(await exists(LEAF_PFX)) || meta.san !== san || (meta.notAfter ?? 0) - Date.now() < RENEW_BEFORE_MS;
  if (stale) {
    await run(MAKE_LEAF, { ...paths, VP_SAN: san });
    await fs.writeFile(LEAF_META, JSON.stringify({ san, notAfter: Date.now() + 397 * 24 * 60 * 60 * 1000 }), "utf8");
  }

  const caCer = await fs.readFile(CA_CER);
  return {
    pfx: await fs.readFile(LEAF_PFX),
    passphrase,
    caCer,
    fingerprint: new X509Certificate(caCer).fingerprint256,
  };
}
