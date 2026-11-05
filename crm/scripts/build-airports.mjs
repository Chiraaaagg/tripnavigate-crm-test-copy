#!/usr/bin/env node
/*
 * Builds crm/src/lib/airports/airports.json, the airport list of the booking
 * form's From / To search (Book now v2, change 3).
 *
 * Source: OurAirports "airports.csv" (https://ourairports.com/data/,
 * davidmegginson.github.io/ourairports-data/airports.csv). OurAirports data is
 * released into the public domain. The copy used for the first build is the
 * export held by the owner's legacy system, file dated 1 October 2026.
 *
 * Rule (lead ruling D9, 26 October 2026): airports with an IATA code and
 * scheduled service, without heliports (about 4,100 rows). Review round 1
 * (26 October 2026): every Indian airport with an IATA code is included too,
 * whether or not the export marks scheduled service (for example SLV Shimla
 * and BKB Bikaner). The 127 rows of the
 * owner-approved prototype (26 October 2026) override city and name, so the
 * search reads exactly as the prototype ("Delhi (DEL)", "Bali (Denpasar)",
 * "Dharamshala"). Prototype rows come first in the file, then large, medium,
 * small and seaplane airports, each by code. A prototype row is kept even when
 * the export marks it without scheduled service (RAJ). Search ranks exact code matches
 * first and keeps this order for the rest.
 *
 * Usage (from crm/): node scripts/build-airports.mjs <path to airports.csv>
 * Output rows: [code, city, airport name, ISO country code], plus 1 as a
 * fifth value on the prototype's rows (search ranks them first).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOTYPE = `
DEL|Delhi|Indira Gandhi International
BOM|Mumbai|Chhatrapati Shivaji Maharaj International
BLR|Bengaluru|Kempegowda International
MAA|Chennai|Chennai International
CCU|Kolkata|Netaji Subhas Chandra Bose International
HYD|Hyderabad|Rajiv Gandhi International
AMD|Ahmedabad|Sardar Vallabhbhai Patel International
COK|Kochi|Cochin International
GOI|Goa|Dabolim
GOX|Goa|Manohar International (Mopa)
JAI|Jaipur|Jaipur International
JDH|Jodhpur|Jodhpur
UDR|Udaipur|Maharana Pratap
PNQ|Pune|Pune
LKO|Lucknow|Chaudhary Charan Singh International
ATQ|Amritsar|Sri Guru Ram Dass Jee International
IXC|Chandigarh|Chandigarh International
SXR|Srinagar|Srinagar
IXL|Leh|Kushok Bakula Rimpochee
IXB|Bagdogra|Bagdogra
GAU|Guwahati|Lokpriya Gopinath Bordoloi International
IXZ|Port Blair|Veer Savarkar International
TRV|Thiruvananthapuram|Thiruvananthapuram International
IXE|Mangaluru|Mangaluru International
VNS|Varanasi|Lal Bahadur Shastri International
PAT|Patna|Jay Prakash Narayan
BBI|Bhubaneswar|Biju Patnaik International
IDR|Indore|Devi Ahilyabai Holkar
BDQ|Vadodara|Vadodara
STV|Surat|Surat
NAG|Nagpur|Dr. Babasaheb Ambedkar International
DED|Dehradun|Jolly Grant
IXJ|Jammu|Jammu
KUU|Kullu|Bhuntar
DHM|Dharamshala|Gaggal
BHO|Bhopal|Raja Bhoj
RPR|Raipur|Swami Vivekananda
VTZ|Visakhapatnam|Visakhapatnam
CJB|Coimbatore|Coimbatore International
IXM|Madurai|Madurai
IXR|Ranchi|Birsa Munda
RAJ|Rajkot|Rajkot International
DXB|Dubai|Dubai International
AUH|Abu Dhabi|Zayed International
SHJ|Sharjah|Sharjah International
DOH|Doha|Hamad International
MCT|Muscat|Muscat International
BAH|Bahrain|Bahrain International
KWI|Kuwait|Kuwait International
RUH|Riyadh|King Khalid International
JED|Jeddah|King Abdulaziz International
BKK|Bangkok|Suvarnabhumi
DMK|Bangkok|Don Mueang
HKT|Phuket|Phuket International
KBV|Krabi|Krabi International
USM|Koh Samui|Samui
CNX|Chiang Mai|Chiang Mai International
SIN|Singapore|Changi
KUL|Kuala Lumpur|Kuala Lumpur International
PEN|Penang|Penang International
LGK|Langkawi|Langkawi International
DPS|Bali (Denpasar)|Ngurah Rai International
CGK|Jakarta|Soekarno–Hatta International
MLE|Malé|Velana International
CMB|Colombo|Bandaranaike International
KTM|Kathmandu|Tribhuvan International
PBH|Paro|Paro International
DAC|Dhaka|Hazrat Shahjalal International
HKG|Hong Kong|Hong Kong International
SGN|Ho Chi Minh City|Tan Son Nhat International
HAN|Hanoi|Noi Bai International
DAD|Da Nang|Da Nang International
MNL|Manila|Ninoy Aquino International
NRT|Tokyo|Narita International
HND|Tokyo|Haneda
ICN|Seoul|Incheon International
PEK|Beijing|Capital International
PVG|Shanghai|Pudong International
SYD|Sydney|Kingsford Smith
MEL|Melbourne|Melbourne
BNE|Brisbane|Brisbane
PER|Perth|Perth
AKL|Auckland|Auckland
MRU|Mauritius|Sir Seewoosagur Ramgoolam International
SEZ|Seychelles (Mahé)|Seychelles International
NBO|Nairobi|Jomo Kenyatta International
JNB|Johannesburg|O. R. Tambo International
CPT|Cape Town|Cape Town International
CAI|Cairo|Cairo International
IST|Istanbul|Istanbul
SAW|Istanbul|Sabiha Gökçen International
GYD|Baku|Heydar Aliyev International
TBS|Tbilisi|Shota Rustaveli Tbilisi International
ALA|Almaty|Almaty International
EVN|Yerevan|Zvartnots International
LHR|London|Heathrow
LGW|London|Gatwick
CDG|Paris|Charles de Gaulle
FRA|Frankfurt|Frankfurt
MUC|Munich|Munich
ZRH|Zurich|Zurich
GVA|Geneva|Geneva
AMS|Amsterdam|Schiphol
FCO|Rome|Fiumicino
MXP|Milan|Malpensa
VCE|Venice|Marco Polo
BCN|Barcelona|El Prat
MAD|Madrid|Barajas
VIE|Vienna|Vienna International
PRG|Prague|Václav Havel
ATH|Athens|Athens International
LIS|Lisbon|Humberto Delgado
DUB|Dublin|Dublin
EDI|Edinburgh|Edinburgh
BRU|Brussels|Brussels
CPH|Copenhagen|Copenhagen
HEL|Helsinki|Helsinki-Vantaa
OSL|Oslo|Gardermoen
ARN|Stockholm|Arlanda
KEF|Reykjavík|Keflavík International
JFK|New York|John F. Kennedy International
EWR|New York (Newark)|Newark Liberty International
SFO|San Francisco|San Francisco International
LAX|Los Angeles|Los Angeles International
ORD|Chicago|O'Hare International
YYZ|Toronto|Pearson International
YVR|Vancouver|Vancouver International
`
  .trim()
  .split('\n')
  .map((line) => line.split('|'));

/**
 * City names staff actually type, for Indian airports outside the prototype's
 * rows whose export city is the airport's village or base (review round 1
 * follow-up, 26 October 2026). The airport name is left as the export has it.
 */
const CITY_OVERRIDE = {
  SLV: 'Shimla', // export: Jubbarhatti
  SAG: 'Shirdi', // Kakadi
  KJB: 'Kurnool', // Orvakal
  RJA: 'Rajahmundry', // Madhurapudi
  SDW: 'Sindhudurg', // Chipi
  TCR: 'Thoothukudi (Tuticorin)', // Vagaikulam
  VDY: 'Ballari (Vidyanagar)', // Toranagallu
  HGI: 'Itanagar', // Hollongi
  IXQ: 'Kamalpur', // Manik Bhandar
  RUP: 'Dhubri (Rupsi)', // Rupsi
  IXI: 'North Lakhimpur', // Lilabari
  CBD: 'Car Nicobar', // IAF Camp
  BUP: 'Bathinda', // Bhatinda Air Force Station
  AYJ: 'Ayodhya', // Faizabad
  IXD: 'Prayagraj (Allahabad)', // Allahabad
  DXN: 'Noida (Jewar)', // Gautam Buddha Nagar
  SWN: 'Saharanpur', // Sherpur Naqeebpur
  CCJ: 'Kozhikode (Calicut)', // Calicut
  TRZ: 'Tiruchirappalli (Trichy)', // Tiruchirappalli
  AJL: 'Aizawl', // Aizawl (Lengpui)
};

const TYPE_RANK = { large_airport: 0, medium_airport: 1, small_airport: 2, seaplane_base: 3 };

/** RFC 4180 line splitter (quoted fields may hold commas and doubled quotes; no field spans lines in this file). */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const tidyName = (name) => name.replace(/\s+/g, ' ').trim().replace(/\s+Airport$/i, '').trim();

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/build-airports.mjs <path to OurAirports airports.csv>');
    process.exit(1);
  }
  const lines = readFileSync(input, 'utf8').split(/\r?\n/);
  const header = splitCsvLine(lines[0]);
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Column "${name}" is missing; is this the OurAirports airports.csv?`);
    return i;
  };
  const C = { type: col('type'), name: col('name'), country: col('iso_country'), city: col('municipality'), scheduled: col('scheduled_service'), iata: col('iata_code') };

  const byCode = new Map();
  /** Every IATA code's country (a prototype row may lack scheduled service in the export, e.g. RAJ). */
  const anyCountry = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    const code = (f[C.iata] ?? '').trim().toUpperCase();
    const type = f[C.type];
    if (/^[A-Z]{3}$/.test(code) && !anyCountry.has(code)) anyCountry.set(code, (f[C.country] ?? '').trim());
    const indian = (f[C.country] ?? '').trim() === 'IN';
    if (!/^[A-Z]{3}$/.test(code) || (f[C.scheduled] !== 'yes' && !indian) || !(type in TYPE_RANK)) continue;
    const row = { code, rank: TYPE_RANK[type], city: (f[C.city] ?? '').trim(), name: tidyName(f[C.name] ?? ''), country: (f[C.country] ?? '').trim() };
    if (!row.city) row.city = row.name;
    const have = byCode.get(code);
    if (!have || row.rank < have.rank) byCode.set(code, row);
  }

  const first = [];
  for (const [code, city, name] of PROTOTYPE) {
    const country = byCode.get(code)?.country ?? anyCountry.get(code);
    if (country === undefined) throw new Error(`Prototype airport ${code} is not in the airport list.`);
    // The owner-approved prototype lists it, so it stays even when the export marks it without scheduled service.
    first.push([code, city, name, country, 1]);
    byCode.delete(code);
  }
  const rest = [...byCode.values()].sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code)).map((r) => [r.code, CITY_OVERRIDE[r.code] ?? r.city, r.name, r.country]);
  const rows = [...first, ...rest];

  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, '../src/lib/airports/airports.json');
  writeFileSync(out, `${JSON.stringify(rows).replace(/\],\[/g, '],\n[')}\n`);
  console.log(`Wrote ${rows.length} airports (${first.length} prototype overrides) to ${out}`);
}

main();
