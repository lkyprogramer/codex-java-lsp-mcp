package lab.payments;

public final class Receipt {
  public final String requestId;
  public final long amountCents;
  public Receipt(String requestId, long amountCents) { this.requestId=requestId; this.amountCents=amountCents; }
}
