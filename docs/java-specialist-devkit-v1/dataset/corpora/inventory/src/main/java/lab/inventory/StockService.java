package lab.inventory;

public final class StockService {
  private int available;
  public StockService(int initial) { available=initial; }
  public Reservation reserve(int quantity) {
    if (quantity <= 0 || quantity > available) throw new IllegalArgumentException("invalid quantity");
    available-=quantity; return new Reservation(quantity);
  }
  /** 取消预留必须幂等，库存只归还一次。 */
  public void release(Reservation r) {
    available+=r.quantity;
    r.active=false;
  }
  public int available() { return available; }
}
