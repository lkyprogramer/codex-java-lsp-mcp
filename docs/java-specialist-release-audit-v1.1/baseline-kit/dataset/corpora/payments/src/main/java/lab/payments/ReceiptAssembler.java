package lab.payments;

public final class ReceiptAssembler {
  public Receipt toReceipt(String id, long amountCents) { return new Receipt(id, amountCents); }
}
