import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: "0.8.26",
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      hardfork: "cancun",
      blockGasLimit: 30_000_000,
    },
  },
});
