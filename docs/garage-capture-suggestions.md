# Garage capture: suggestions from parts-inference analysis (2026-11-08)

These suggestions come from the Forza Tuning project, which tried to infer installed parts from what My Cars shows. They cover what to capture and what to skip. The matching itself stays downstream in forzagarage.

## What each screen gives us
| Screen | Fields | Use downstream |
|---|---|---|
| My Cars tile grid (about 8 cars per screen) | name, year, class/PI, drivetrain icon, tire icon, rarity, car render (shows a rear wing at tile size) | flags whether a car is upgraded (PI differs from stock), drivetrain swap, tire compound, rough aero |
| Ratings panel (`car-NNNN-1`) | PI, six ratings, tire compound, drivetrain | actual performance; part of the parts match |
| Details panel (`car-NNNN-2`, Toggle Stats) | hp, torque, weight, front %, displacement | the most useful input for inferring parts: displacement shows engine swaps, hp/torque show engine and aspiration parts, weight shows weight reduction |

Ratings alone can't identify parts. None of 14 scanned upgraded cars matched any ForzaLabs community build. With ratings plus details, a per-car model got the engine swap and aspiration right in 17–24 of 25 held-out builds, and 75–86% of the chassis, tire and aero slots.

## Suggested capture plan
1. Scan the tile grid for the whole collection. It's cheap, at about 8 cars per screenshot.
2. Compare each tile's PI with the car's stock PI (from the car-ids/stock data). Skip cars at stock PI, and skip D-class cars, which the owner treats as unbuilt.
3. For the remaining upgraded cars only, capture the ratings panel and the details panel.
4. Only drill into the upgrade screens for cars the downstream match flags as uncertain.

## Bug: GeForce Now captures rejected
`garage-SXnmaM` (2026-10-25, 30 cars) extracted nothing. Every capture failed with "My Cars extraction requires a game-only 16:9 screenshot without letterboxing" (`src/ocr/car-performance.ts`, the aspect check in `extractCarPerformance`). The captures are 1920×1281. Looking at them, the game UI fills the frame and is readable; it just isn't 16:9. Suggest deriving the panel regions from the actual frame (anchor on the "My Cars" header or the left panel) instead of rejecting non-16:9 frames. The earlier `garage-lrjbGy` run (15 cars) extracted fine.

## Small OCR note
For the 2001 Integra Type R, the front-weight reading was kept as 52% while the screenshot shows 62%. The two OCR engines disagreed, and the shape-based reading won but was wrong.
