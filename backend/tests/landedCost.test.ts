/**
 * Pure allocateShipmentCosts — cents by largest remainder; FINAL supersedes ESTIMATED.
 */
import {
  CostAllocationBasis,
  ShipmentCostStatus,
  ShipmentCostType,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/errors.js";
import {
  allocateCentsByLargestRemainder,
  allocateShipmentCosts,
  selectActiveCosts,
} from "../src/services/landedCost.service.js";

const lines = [
  {
    id: "L1",
    customsValueUsd: 100,
    grossWeightKg: 10,
    volumeCbm: 1,
    quantity: 10,
    dutyAmountUsd: 6,
  },
  {
    id: "L2",
    customsValueUsd: 300,
    grossWeightKg: 30,
    volumeCbm: 3,
    quantity: 30,
    dutyAmountUsd: 14,
  },
];

describe("allocateCentsByLargestRemainder", () => {
  it("pieces sum exactly to totalCents", () => {
    const pieces = allocateCentsByLargestRemainder(100, [1, 1, 1]);
    expect(pieces.reduce((a, b) => a + b, 0)).toBe(100);
    // 33, 33, 34 — two get remainder
    expect(pieces.sort((a, b) => a - b)).toEqual([33, 33, 34]);
  });

  it("rejects zero weight sum", () => {
    expect(() => allocateCentsByLargestRemainder(50, [0, 0])).toThrow(AppError);
  });
});

describe("selectActiveCosts", () => {
  it("drops ESTIMATED rows superseded by FINAL", () => {
    const active = selectActiveCosts([
      {
        id: "e1",
        costType: ShipmentCostType.OCEAN_FREIGHT,
        amountUsd: 100,
        allocationBasis: CostAllocationBasis.VALUE,
        status: ShipmentCostStatus.ESTIMATED,
        supersedesCostId: null,
      },
      {
        id: "f1",
        costType: ShipmentCostType.OCEAN_FREIGHT,
        amountUsd: 120,
        allocationBasis: CostAllocationBasis.VALUE,
        status: ShipmentCostStatus.FINAL,
        supersedesCostId: "e1",
      },
      {
        id: "e2",
        costType: ShipmentCostType.INSURANCE,
        amountUsd: 10,
        allocationBasis: CostAllocationBasis.VALUE,
        status: ShipmentCostStatus.ESTIMATED,
        supersedesCostId: null,
      },
    ]);
    expect(active.map((c) => c.id).sort()).toEqual(["e2", "f1"]);
  });
});

describe("allocateShipmentCosts", () => {
  it("VALUE basis splits by customsValueUsd; cents sum to cost", () => {
    const result = allocateShipmentCosts(lines, [
      {
        id: "c1",
        costType: ShipmentCostType.BROKER_FEE,
        amountUsd: 40,
        allocationBasis: CostAllocationBasis.VALUE,
        status: ShipmentCostStatus.ESTIMATED,
      },
    ]);
    // 100:300 → 10 + 30 = 40
    expect(Number(result[0]!.landedAddOnTotal)).toBe(10);
    expect(Number(result[1]!.landedAddOnTotal)).toBe(30);
    expect(
      Number(result[0]!.landedAddOnTotal) + Number(result[1]!.landedAddOnTotal),
    ).toBe(40);
    expect(Number(result[0]!.landedAddOnPerUnit)).toBe(1); // 10/10
    expect(Number(result[1]!.landedAddOnPerUnit)).toBe(1); // 30/30
    expect(Number(result[0]!.upliftPercent)).toBe(10); // 10/100
  });

  it("WEIGHT / VOLUME / QUANTITY bases", () => {
    const byWeight = allocateShipmentCosts(lines, [
      {
        id: "w",
        costType: ShipmentCostType.AIR_FREIGHT,
        amountUsd: 40,
        allocationBasis: CostAllocationBasis.WEIGHT,
        status: ShipmentCostStatus.FINAL,
      },
    ]);
    expect(Number(byWeight[0]!.landedAddOnTotal)).toBe(10);
    expect(Number(byWeight[1]!.landedAddOnTotal)).toBe(30);

    const byVolume = allocateShipmentCosts(lines, [
      {
        id: "v",
        costType: ShipmentCostType.OCEAN_FREIGHT,
        amountUsd: 40,
        allocationBasis: CostAllocationBasis.VOLUME,
        status: ShipmentCostStatus.FINAL,
      },
    ]);
    expect(Number(byVolume[0]!.landedAddOnTotal)).toBe(10);
    expect(Number(byVolume[1]!.landedAddOnTotal)).toBe(30);

    const byQty = allocateShipmentCosts(lines, [
      {
        id: "q",
        costType: ShipmentCostType.PORT_CHARGES,
        amountUsd: 40,
        allocationBasis: CostAllocationBasis.QUANTITY,
        status: ShipmentCostStatus.FINAL,
      },
    ]);
    expect(Number(byQty[0]!.landedAddOnTotal)).toBe(10);
    expect(Number(byQty[1]!.landedAddOnTotal)).toBe(30);
  });

  it("LINE_SPECIFIC uses dutyAmountUsd and errors when sum ≠ cost", () => {
    const ok = allocateShipmentCosts(lines, [
      {
        id: "d",
        costType: ShipmentCostType.CUSTOMS_DUTY,
        amountUsd: 20, // 6+14
        allocationBasis: CostAllocationBasis.LINE_SPECIFIC,
        status: ShipmentCostStatus.FINAL,
      },
    ]);
    expect(Number(ok[0]!.landedAddOnTotal)).toBe(6);
    expect(Number(ok[1]!.landedAddOnTotal)).toBe(14);

    expect(() =>
      allocateShipmentCosts(lines, [
        {
          id: "bad",
          costType: ShipmentCostType.CUSTOMS_DUTY,
          amountUsd: 25,
          allocationBasis: CostAllocationBasis.LINE_SPECIFIC,
          status: ShipmentCostStatus.FINAL,
        },
      ]),
    ).toThrow(AppError);
  });

  it("FINAL supersedes ESTIMATED so only final amount is allocated", () => {
    const result = allocateShipmentCosts(lines, [
      {
        id: "e1",
        costType: ShipmentCostType.OCEAN_FREIGHT,
        amountUsd: 100,
        allocationBasis: CostAllocationBasis.VALUE,
        status: ShipmentCostStatus.ESTIMATED,
      },
      {
        id: "f1",
        costType: ShipmentCostType.OCEAN_FREIGHT,
        amountUsd: 40,
        allocationBasis: CostAllocationBasis.VALUE,
        status: ShipmentCostStatus.FINAL,
        supersedesCostId: "e1",
      },
    ]);
    const total =
      Number(result[0]!.landedAddOnTotal) + Number(result[1]!.landedAddOnTotal);
    expect(total).toBe(40);
  });

  it("largest remainder keeps odd cents exact (e.g. $10 across 3 equal lines)", () => {
    const three = [
      { id: "a", customsValueUsd: 1, quantity: 1 },
      { id: "b", customsValueUsd: 1, quantity: 1 },
      { id: "c", customsValueUsd: 1, quantity: 1 },
    ];
    const result = allocateShipmentCosts(three, [
      {
        id: "odd",
        costType: ShipmentCostType.OTHER,
        amountUsd: 10,
        allocationBasis: CostAllocationBasis.VALUE,
        status: ShipmentCostStatus.FINAL,
      },
    ]);
    const cents = result.map((r) => Math.round(Number(r.landedAddOnTotal) * 100));
    expect(cents.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(cents.sort((a, b) => a - b)).toEqual([333, 333, 334]);
  });

  it("$1,000.00 across 3 equal lines sums exactly; awkward 7-way split too", () => {
    const three = [
      { id: "a", customsValueUsd: 100, quantity: 10 },
      { id: "b", customsValueUsd: 100, quantity: 10 },
      { id: "c", customsValueUsd: 100, quantity: 10 },
    ];
    const thousand = allocateShipmentCosts(three, [
      {
        id: "k",
        costType: ShipmentCostType.OCEAN_FREIGHT,
        amountUsd: 1000,
        allocationBasis: CostAllocationBasis.VALUE,
        status: ShipmentCostStatus.FINAL,
      },
    ]);
    const thousandCents = thousand.map((r) =>
      Math.round(Number(r.landedAddOnTotal) * 100),
    );
    expect(thousandCents.reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(thousandCents.sort((a, b) => a - b)).toEqual([33333, 33333, 33334]);

    const seven = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      customsValueUsd: 1,
      quantity: 1,
    }));
    const awkward = allocateShipmentCosts(seven, [
      {
        id: "awk",
        costType: ShipmentCostType.OTHER,
        amountUsd: 1.01,
        allocationBasis: CostAllocationBasis.QUANTITY,
        status: ShipmentCostStatus.FINAL,
      },
    ]);
    const awkwardCents = awkward.map((r) =>
      Math.round(Number(r.landedAddOnTotal) * 100),
    );
    expect(awkwardCents.reduce((a, b) => a + b, 0)).toBe(101);
  });

  it("$1,000.00 across 3 equal lines sums exactly; awkward 7-way split too", () => {
    const three = [
      { id: "a", customsValueUsd: 100, quantity: 10 },
      { id: "b", customsValueUsd: 100, quantity: 10 },
      { id: "c", customsValueUsd: 100, quantity: 10 },
    ];
    const thousand = allocateShipmentCosts(three, [
      {
        id: "k",
        costType: ShipmentCostType.OCEAN_FREIGHT,
        amountUsd: 1000,
        allocationBasis: CostAllocationBasis.VALUE,
        status: ShipmentCostStatus.FINAL,
      },
    ]);
    const thousandCents = thousand.map((r) =>
      Math.round(Number(r.landedAddOnTotal) * 100),
    );
    expect(thousandCents.reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(thousandCents.sort((a, b) => a - b)).toEqual([33333, 33333, 33334]);

    const seven = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      customsValueUsd: 1,
      quantity: 1,
    }));
    const awkward = allocateShipmentCosts(seven, [
      {
        id: "awk",
        costType: ShipmentCostType.OTHER,
        amountUsd: 1.01,
        allocationBasis: CostAllocationBasis.QUANTITY,
        status: ShipmentCostStatus.FINAL,
      },
    ]);
    const awkwardCents = awkward.map((r) =>
      Math.round(Number(r.landedAddOnTotal) * 100),
    );
    expect(awkwardCents.reduce((a, b) => a + b, 0)).toBe(101);
  });

  it("stacks multiple cost types into allocatedByCostType", () => {
    const result = allocateShipmentCosts(lines, [
      {
        id: "f",
        costType: ShipmentCostType.OCEAN_FREIGHT,
        amountUsd: 40,
        allocationBasis: CostAllocationBasis.VALUE,
        status: ShipmentCostStatus.FINAL,
      },
      {
        id: "d",
        costType: ShipmentCostType.CUSTOMS_DUTY,
        amountUsd: 20,
        allocationBasis: CostAllocationBasis.LINE_SPECIFIC,
        status: ShipmentCostStatus.FINAL,
      },
    ]);
    expect(Number(result[0]!.allocatedByCostType.OCEAN_FREIGHT)).toBe(10);
    expect(Number(result[0]!.allocatedByCostType.CUSTOMS_DUTY)).toBe(6);
    expect(Number(result[0]!.landedAddOnTotal)).toBe(16);
    expect(Number(result[0]!.landedUnitCost)).toBe(11.6); // 100/10 + 1.6
  });
});
