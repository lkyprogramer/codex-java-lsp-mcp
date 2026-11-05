package example;
import java.util.HashSet;
import java.util.Set;
public class StockLedger {
    private final Set<Long> reserved = new HashSet<>();
    public void reserve(long id) { reserved.add(id); }
    public void release(long id) { reserved.remove(id); }
    public boolean contains(long id) { return reserved.contains(id); }
}
