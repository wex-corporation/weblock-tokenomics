import hre from "hardhat";

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

export function parseBool(value, defaultValue = false) {
  if (value == null || value === "") {
    return defaultValue;
  }
  return value.toLowerCase() === "true";
}

export function parseAddressList(name) {
  return requireEnv(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseBigIntList(name) {
  return requireEnv(name)
    .split(",")
    .map((value) => BigInt(value.trim()));
}

export function parseNumberList(name) {
  return requireEnv(name)
    .split(",")
    .map((value) => Number(value.trim()));
}

export function optionalBigInt(name, defaultValue = 0n) {
  const value = process.env[name];
  return value ? BigInt(value) : defaultValue;
}

export function optionalNumber(name, defaultValue = 0) {
  const value = process.env[name];
  return value ? Number(value) : defaultValue;
}

export async function getConnection() {
  return hre.network.connect();
}

export async function getDefaultSigner() {
  const connection = await getConnection();
  const { ethers } = connection;
  const [signer] = await ethers.getSigners();
  return { connection, ethers, signer };
}
