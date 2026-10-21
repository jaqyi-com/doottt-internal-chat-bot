// Domain lists for GCC (Global Capability Center) detection. There is no GCC column in the DB, so
// a row is tagged from its email / website domain: known GCC parents → yes, IT vendors → no,
// free-mail → no signal, anything else → classified by the LLM (enrich node) and cached.

export type GccInfo = { gcc: "yes" | "likely" | "no" | "unknown"; company?: string; sector?: string };

const GCC_LIST: [string[], string, string][] = [
  [["gs.com"], "Goldman Sachs", "BFSI"],
  [["jpmchase.com", "jpmorgan.com"], "JPMorgan Chase", "BFSI"],
  [["morganstanley.com"], "Morgan Stanley", "BFSI"],
  [["wellsfargo.com"], "Wells Fargo", "BFSI"],
  [["fmr.com", "fidelity.com"], "Fidelity Investments", "BFSI"],
  [["db.com"], "Deutsche Bank", "BFSI"],
  [["ubs.com"], "UBS", "BFSI"],
  [["hsbc.com", "hsbc.co.in"], "HSBC", "BFSI"],
  [["barclays.com"], "Barclays", "BFSI"],
  [["citi.com"], "Citi", "BFSI"],
  [["bofa.com", "bankofamerica.com"], "Bank of America", "BFSI"],
  [["sc.com"], "Standard Chartered", "BFSI"],
  [["aexp.com"], "American Express", "BFSI"],
  [["visa.com"], "Visa", "BFSI/Tech"],
  [["mastercard.com"], "Mastercard", "BFSI/Tech"],
  [["statestreet.com"], "State Street", "BFSI"],
  [["ntrs.com"], "Northern Trust", "BFSI"],
  [["blackrock.com"], "BlackRock", "BFSI"],
  [["lseg.com"], "LSEG", "BFSI"],
  [["socgen.com"], "Société Générale", "BFSI"],
  [["anz.com"], "ANZ", "BFSI"],
  [["target.com"], "Target", "Retail"],
  [["walmart.com"], "Walmart Global Tech", "Retail"],
  [["lowes.com"], "Lowe's", "Retail"],
  [["tesco.com"], "Tesco", "Retail"],
  [["sap.com"], "SAP Labs", "Tech"],
  [["intel.com"], "Intel", "Tech"],
  [["cisco.com"], "Cisco", "Tech"],
  [["microsoft.com"], "Microsoft", "Tech"],
  [["google.com"], "Google", "Tech"],
  [["amazon.com"], "Amazon", "Tech/Retail"],
  [["oracle.com"], "Oracle", "Tech"],
  [["adobe.com"], "Adobe", "Tech"],
  [["salesforce.com"], "Salesforce", "Tech"],
  [["intuit.com"], "Intuit", "Tech"],
  [["nvidia.com"], "NVIDIA", "Tech"],
  [["qualcomm.com"], "Qualcomm", "Tech"],
  [["nokia.com"], "Nokia", "Tech"],
  [["ericsson.com"], "Ericsson", "Tech"],
  [["boeing.com"], "Boeing", "Engineering"],
  [["airbus.com"], "Airbus", "Engineering"],
  [["ge.com", "gehealthcare.com"], "GE / GE HealthCare", "Engineering/Healthcare"],
  [["honeywell.com"], "Honeywell", "Engineering"],
  [["siemens.com", "siemens-healthineers.com"], "Siemens / Healthineers", "Engineering/Healthcare"],
  [["bosch.com"], "Bosch", "Engineering/Manufacturing"],
  [["mercedes-benz.com"], "Mercedes-Benz R&D", "Engineering/Auto"],
  [["continental.com"], "Continental", "Auto"],
  [["abb.com"], "ABB", "Engineering"],
  [["cat.com"], "Caterpillar", "Manufacturing"],
  [["johndeere.com"], "John Deere", "Manufacturing"],
  [["volvo.com"], "Volvo Group", "Auto"],
  [["shell.com"], "Shell", "Energy"],
  [["philips.com"], "Philips", "Healthcare"],
  [["novartis.com"], "Novartis", "Healthcare"],
  [["astrazeneca.com"], "AstraZeneca", "Healthcare"],
  [["unilever.com"], "Unilever", "FMCG"],
  [["pg.com"], "P&G", "FMCG"],
];

export const GCC_DOMAINS: Record<string, GccInfo> = Object.fromEntries(
  GCC_LIST.flatMap(([domains, company, sector]) => domains.map((d) => [d, { gcc: "yes", company, sector } as GccInfo])),
);

// IT services / outsourcing vendors: big employers in India, but NOT GCCs.
export const IT_VENDOR_DOMAINS = new Set([
  "tcs.com", "infosys.com", "wipro.com", "hcl.com", "hcltech.com", "techmahindra.com", "cognizant.com",
  "accenture.com", "capgemini.com", "ltimindtree.com", "lntinfotech.com", "mindtree.com", "mphasis.com",
  "lnttechservices.com", "ltts.com", "persistent.com", "coforge.com", "hexaware.com", "zensar.com",
  "birlasoft.com", "cyient.com", "kpit.com", "sonata-software.com", "mastek.com", "niit-tech.com",
  "ibm.com", "in.ibm.com", "dxc.com", "nttdata.com", "atos.net", "genpact.com", "wns.com", "exlservice.com",
  "firstsource.com", "teleperformance.com", "concentrix.com", "ust.com", "virtusa.com", "happiestminds.com",
]);

export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "rocketmail.com",
  "hotmail.com", "hotmail.co.in", "outlook.com", "outlook.in", "live.com", "live.in", "msn.com",
  "rediffmail.com", "rediff.com", "icloud.com", "me.com", "mac.com", "aol.com", "protonmail.com", "proton.me",
  "zoho.com", "zohomail.in", "mail.com", "gmx.com", "yandex.com", "inbox.com", "sify.com", "vsnl.net",
  "vsnl.com", "bsnl.in", "indiatimes.com", "in.com", "example.com",
]);

// Known answer for a domain without the LLM, or null when it needs classification.
export function knownDomain(domain: string): GccInfo | null {
  const d = domain.toLowerCase();
  if (GCC_DOMAINS[d]) return GCC_DOMAINS[d];
  // subdomains like in.ey.com / corp.walmart.com
  const parent = d.split(".").slice(-2).join(".");
  if (GCC_DOMAINS[parent]) return GCC_DOMAINS[parent];
  if (IT_VENDOR_DOMAINS.has(d) || IT_VENDOR_DOMAINS.has(parent)) return { gcc: "no" };
  if (FREE_MAIL_DOMAINS.has(d)) return { gcc: "unknown" };
  return null;
}
