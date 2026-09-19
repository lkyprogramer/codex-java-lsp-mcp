package lab.inventory;

public final class StockEndpoint {
  private final StockService stock;
  public StockEndpoint(StockService stock) { this.stock=stock; }
  public Reservation hold(int units) { return stock.reserve(units); }
  public void cancel(Reservation reservation) { stock.release(reservation); }
}
