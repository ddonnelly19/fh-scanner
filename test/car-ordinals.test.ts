import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { formatOrdinalResults, loadCarNameMapping, matchCarText, parseCarNameMapping, parseCarText } from "../src/collection/car-matching.ts";
import { parseOrdinalCatalog } from "../src/catalogs/hdr.ts";
import { exportCarOrdinals } from "../src/workflows/export-cars.ts";

const entries = parseOrdinalCatalog({
	"2001 Acura Integra Type R": "368",
	"2002 Acura RSX Type-S": "422",
	"2022 Acura NSX Type S": "3767",
	"2008 Alfa Romeo 8C Competizione": "1032",
	"1980 Fiat 131 Abarth Stradale": "1124",
	"ABC_Internal_22": "9999",
});

test("parses OCR model followed by year/manufacturer including wrapped model names", () => {
	assert.equal(parseCarText("RSX Type S\r\n2002 Acura\n"), "2002 Acura RSX Type S");
	assert.equal(parseCarText("Autodelta Tipo\n33/2 Daytona\n1968 Alfa Romeo"), "1968 Alfa Romeo Autodelta Tipo 33/2 Daytona");
	for (const text of ["", "Integra Type R", "2001 Acura", "Integra\n2001 Acura\n2002 Acura"]) {
		assert.equal(parseCarText(text), null);
	}
});

test("exact normalized matching handles case, punctuation, accents, and spacing", () => {
	const match = matchCarText({ source: "tile.txt", text: "RSX TYPE S\n2002 ACURA" }, entries);
	assert.equal(match.status, "matched");
	assert.equal(match.candidates[0]?.ordinal, "422");
	const accented = matchCarText({ source: "tile.txt", text: "Mégane R.S.\n2018 Renault" },
		parseOrdinalCatalog({ "2018 Renault Megane RS": "1234" }));
	assert.equal(accented.status, "matched");
});

test("year, manufacturer, model differences and internal filenames are never guessed", () => {
	for (const text of [
		"8C Competizione\n2007 Alfa Romeo",
		"Fiat 131\n1980 Abarth",
		"RSX Type R\n2002 Acura",
		"Internal\n2022 ABC",
	]) {
		assert.equal(matchCarText({ source: "tile.txt", text }, entries).status, "unmatched");
	}
	const match = matchCarText({ source: "tile.txt", text: "8C Competizione\n2007 Alfa Romeo" }, entries);
	assert.deepEqual(match.candidates, []);
	assert.equal(matchCarText({ source: "tile.txt", text: "" }, entries).status, "invalid");
});

test("multiple distinct ordinals for the same normalized car remain ambiguous", () => {
	const catalog = parseOrdinalCatalog({ "2002 Acura RSX Type-S": "422", "2002 Acura RSX Type S": "5000" });
	assert.equal(matchCarText({ source: "tile.txt", text: "RSX Type S\n2002 Acura" }, catalog).status, "ambiguous");
	const sameOrdinal = catalog.map((entry) => ({ ...entry, ordinal: "422" }));
	assert.equal(matchCarText({ source: "tile.txt", text: "RSX Type S\n2002 Acura" }, sameOrdinal).status, "matched");
});

test("output contains sorted deduplicated matched catalog names and excludes unresolved candidates", () => {
	const cars = [
		{ source: "a.txt", text: "NSX Type S\n2022 Acura" },
		{ source: "b.txt", text: "Integra Type R\n2001 Acura" },
		{ source: "c.txt", text: "NSX Type S\n2022 Acura" },
		{ source: "d.txt", text: "8C Competizione\n2007 Alfa Romeo" },
	];
	const formatted = formatOrdinalResults(cars.map((car) => matchCarText(car, entries)));
	assert.equal(formatted.ordinals, "2001 Acura Integra Type R\n2022 Acura NSX Type S\n");
	assert.match(formatted.review, /\[UNMATCHED\] d.txt/);
	assert.doesNotMatch(formatted.review, /Candidate \(not accepted\): 1032/);
	assert.match(formatted.matched, /3767\t2022 Acura NSX Type S\ta.txt/);
	assert.equal(formatOrdinalResults([]).ordinals, "");
});

test("rejects invalid or empty catalog rather than returning an empty success", () => {
	for (const value of [null, [], {}, { Car: "abc" }, { Car: 422 }, { Car: "0" }, { "": "1" }]) {
		assert.throws(() => parseOrdinalCatalog(value));
	}
});

test("persists exact ordinal output, review, traceability, and source snapshot using an offline catalog", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-scanner-ordinals-"));
	try {
		const catalogPath = join(directory, "catalog.json");
		const content = JSON.stringify({ "2002 Acura RSX Type-S": "422" });
		await writeFile(catalogPath, content);
		const result = await exportCarOrdinals([
			{ source: "tiles\\one.txt", text: "RSX Type S\n2002 Acura" },
			{ source: "tiles\\two.txt", text: "RSX Type S\n2002 Acura" },
			{ source: "tiles\\three.txt", text: "" },
		], directory, { catalogPath });
		assert.deepEqual(result, { matched: 2, unresolved: 1, uniqueNames: 1 });
		assert.equal(await readFile(join(directory, "ordinals.txt"), "utf8"), "2002 Acura RSX Type-S\n");
		assert.match(await readFile(join(directory, "ordinal-review.txt"), "utf8"), /\[INVALID\] tiles\\three.txt/);
		assert.match(await readFile(join(directory, "ordinal-matches.txt"), "utf8"), /tiles\\one.txt/);
		assert.equal(await readFile(join(directory, "car-ordinals-source.json"), "utf8"), content);
		await assert.rejects(exportCarOrdinals([], directory, { catalogPath: join(directory, "missing.json") }), /ENOENT/);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("manual name mapping resolves catalog aliases and overrides automatic matches", () => {
	const mapping = parseCarNameMapping({
		"1980 Abarth Fiat 131": "1980 Fiat 131 Abarth Stradale",
		"2002 Acura RSX Type S": "2022 Acura NSX Type S",
	}, entries);
	const fiat = matchCarText({ source: "fiat.txt", text: "Fiat 131\n1980 Abarth" }, entries, mapping);
	assert.equal(fiat.status, "matched");
	assert.equal(fiat.candidates[0]?.ordinal, "1124");
	assert.equal(matchCarText({ source: "rsx.txt", text: "RSX Type S\n2002 Acura" }, entries, mapping).candidates[0]?.ordinal, "3767");
	const pending = matchCarText({ source: "rsx.txt", text: "RSX Type S\n2002 Acura" }, entries, { "2002 Acura RSX Type S": null });
	assert.equal(pending.status, "unmatched");
});

test("invalid mapping targets and format fail explicitly", () => {
	for (const value of [[], null, { Car: 1124 }, { Car: "" }, { Car: "Unknown catalog car" }, { "": null }]) {
		assert.throws(() => parseCarNameMapping(value, entries), /mapping/);
	}
	assert.deepEqual(parseCarNameMapping({ Car: null }, entries), { Car: null });
});

test("mapping is populated once, preserves manual edits and pending entries, and is reusable across runs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-scanner-mapping-"));
	try {
		const mappingPath = join(directory, "mapping.json");
		const catalogPath = join(directory, "catalog.json");
		await writeFile(catalogPath, JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.name, entry.ordinal]))));
		const cars = [
			{ source: "one.txt", text: "RSX Type S\n2002 Acura" },
			{ source: "two.txt", text: "Fiat 131\n1980 Abarth" },
			{ source: "invalid.txt", text: "" },
		];
		await exportCarOrdinals(cars, directory, { catalogPath, mappingPath });
		const mapping = await loadCarNameMapping(mappingPath, entries);
		assert.equal(Object.keys(mapping).length, 2);
		assert.equal(mapping["2002 Acura RSX Type S"], "2002 Acura RSX Type-S");
		assert.deepEqual(mapping["1980 Abarth Fiat 131"], {
			selected: null, candidates: ["1980 Fiat 131 Abarth Stradale"],
		});
		mapping["1980 Abarth Fiat 131"] = "1980 Fiat 131 Abarth Stradale";
		mapping["2007 Alfa Romeo 8C Competizione"] = null;
		await writeFile(mappingPath, JSON.stringify(mapping));
		const result = await exportCarOrdinals(cars, directory, { catalogPath, mappingPath });
		assert.equal(result.matched, 2);
		assert.equal(await readFile(join(directory, "ordinals.txt"), "utf8"), "1980 Fiat 131 Abarth Stradale\n2002 Acura RSX Type-S\n");
		assert.deepEqual(await loadCarNameMapping(mappingPath, entries), mapping);
		await writeFile(mappingPath, "{bad json");
		await assert.rejects(exportCarOrdinals(cars, directory, { catalogPath, mappingPath }), SyntaxError);
		assert.equal(await readFile(join(directory, "ordinals.txt"), "utf8"), "1980 Fiat 131 Abarth Stradale\n2002 Acura RSX Type-S\n");
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("candidate choices remain unresolved until selected and validate catalog names", () => {
	const mapping = parseCarNameMapping({
		"1980 Abarth Fiat 131": {
			selected: null,
			candidates: ["1980 Fiat 131 Abarth Stradale"],
		},
	}, entries);
	const car = { source: "fiat.txt", text: "Fiat 131\n1980 Abarth" };
	assert.equal(matchCarText(car, entries, mapping).status, "unmatched");
	mapping["1980 Abarth Fiat 131"] = {
		selected: "1980 Fiat 131 Abarth Stradale",
		candidates: ["1980 Fiat 131 Abarth Stradale"],
	};
	assert.equal(matchCarText(car, entries, mapping).candidates[0]?.ordinal, "1124");
	assert.equal(matchCarText(car, entries, mapping).status, "matched");
	for (const choices of [
		{ selected: null, candidates: ["Unknown"] },
		{ selected: "Unknown", candidates: [] },
		{ selected: null, candidates: "not an array" },
		{ candidates: [] },
	]) {
		assert.throws(() => parseCarNameMapping({ Car: choices }, entries), /mapping/);
	}
});

test("candidate suggestions are filtered by source year before similarity ranking", () => {
	const catalog = parseOrdinalCatalog({
		"1964 Aston Martin DB5 Vantage": "1105",
		"2019 Aston Martin DBX": "3000",
		"2017 Aston Martin DB11": "3001",
		"2003 Aston Martin DB7 GT": "3002",
	});
	const match = matchCarText({ source: "db5.txt", text: "DB5\n1964 Aston Martin" }, catalog);
	assert.equal(match.status, "unmatched");
	assert.deepEqual(match.candidates, [{ name: "1964 Aston Martin DB5 Vantage", ordinal: "1105" }]);
});

test("refreshes legacy cross-year suggestions without modifying manual selections", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-scanner-year-"));
	try {
		const catalogPath = join(directory, "catalog.json");
		const mappingPath = join(directory, "mapping.json");
		await writeFile(catalogPath, JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.name, entry.ordinal]))));
		await writeFile(mappingPath, JSON.stringify({
			"1980 Abarth Fiat 131": {
				selected: null, candidates: ["1980 Fiat 131 Abarth Stradale", "2022 Acura NSX Type S"],
			},
			"2007 Alfa Romeo 8C Competizione": {
				selected: "2008 Alfa Romeo 8C Competizione", candidates: ["2008 Alfa Romeo 8C Competizione"],
			},
		}));
		await exportCarOrdinals([
			{ source: "fiat.txt", text: "Fiat 131\n1980 Abarth" },
			{ source: "alfa.txt", text: "8C Competizione\n2007 Alfa Romeo" },
		], directory, { catalogPath, mappingPath });
		const mapping = await loadCarNameMapping(mappingPath, entries);
		assert.deepEqual(mapping["1980 Abarth Fiat 131"], {
			selected: null, candidates: ["1980 Fiat 131 Abarth Stradale"],
		});
		assert.deepEqual(mapping["2007 Alfa Romeo 8C Competizione"], {
			selected: "2008 Alfa Romeo 8C Competizione", candidates: ["2008 Alfa Romeo 8C Competizione"],
		});
		assert.equal(await readFile(join(directory, "ordinals.txt"), "utf8"), "2008 Alfa Romeo 8C Competizione\n");
	} finally {
		await rm(directory, { recursive: true });
	}
});
