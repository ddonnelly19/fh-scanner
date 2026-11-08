import { describe, expect, it } from "vitest";
import { matchCatalog, normalizeCarName } from "../src/ocr/card-catalog.ts";

const cars = [
	{ ordinal: 1, name: "1970 Chevrolet Chevelle Super Sport 454" },
	{ ordinal: 2, name: "1964 Chevrolet Impala Super Sport 409" },
	{ ordinal: 3, name: "2008 BMW Z4 M Coupé" },
	{ ordinal: 4, name: "2018 Mercedes-AMG E 63 S" },
	{ ordinal: 5, name: "2018 Mercedes-AMG GT 4-Door Coupé" },
	{ ordinal: 6, name: "2019 Mercedes-AMG GT 4-Door Coupé" },
	{ ordinal: 7, name: "2018 Mercedes-AMG GT R" },
];
const cutOff = "Name or manufacturer is cut off with an ellipsis on the card.";
const card = (year: number, manufacturer: string, name: string, nameComplete = true) =>
	({ car: { year, manufacturer, name }, nameComplete, issues: nameComplete ? [] : [cutOff] });

describe("car list matching", () => {
	it("normalizes like car-ids", () => {
		expect(normalizeCarName("Z4 M COUPÉ")).toBe("z4 m coupe");
	});
	it("matches a complete name exactly", () => {
		expect(matchCatalog(card(2008, "BMW", "Z4 M COUPE"), cars).catalog?.ordinal).toBe(3);
		expect(matchCatalog(card(2008, "BMW", "Z4"), cars).catalog).toBeNull();
	});
	it("completes a name cut off on the card and drops the cut-off issue", () => {
		const matched = matchCatalog(card(1970, "CHEVROLET", "CHEVELLE SUPER SPOR", false), cars);
		expect(matched.catalog).toEqual(cars[0]);
		expect(matched.issues).toEqual([]);
	});
	it("completes a cut-off manufacturer from the year and model", () => {
		expect(matchCatalog(card(2018, "MERCEDES-A", "E 63 S", false), cars).catalog?.ordinal).toBe(4);
	});
	it("leaves a cut-off name that fits several cars unmatched and flagged", () => {
		const matched = matchCatalog(card(2018, "MERCEDES-AMG", "GT", false), cars);
		expect(matched.catalog).toBeNull();
		expect(matched.issues).toEqual([cutOff]);
		expect(matchCatalog(card(2019, "MERCEDES-AMG", "GT 4-DOOR", false), cars).catalog?.ordinal).toBe(6);
	});
});
