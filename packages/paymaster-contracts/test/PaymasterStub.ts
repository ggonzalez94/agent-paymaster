import { expect } from "chai";
import { ethers } from "hardhat";

describe("PaymasterStub", () => {
  it("sets deployer as owner", async () => {
    const [deployer] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("PaymasterStub");
    const contract = await factory.deploy();
    await contract.waitForDeployment();

    expect(await contract.owner()).to.equal(deployer.address);
  });

  it("allows owner to emit Sponsored event", async () => {
    const [, account] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("PaymasterStub");
    const contract = await factory.deploy();
    await contract.waitForDeployment();

    await expect(contract.sponsor(account.address, 1_000n))
      .to.emit(contract, "Sponsored")
      .withArgs(await contract.owner(), account.address, 1_000n);
  });
});
